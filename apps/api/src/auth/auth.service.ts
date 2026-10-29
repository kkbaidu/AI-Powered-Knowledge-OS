import { isIP } from "node:net";
import type { Config } from "../config.js";
import type { DbExecutor } from "../db/client.js";
import { AuthError, BusinessRuleError, PermissionError } from "../types/errors.js";
import { signAccessToken } from "./accessTokens.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { insertSession } from "./sessions.repository.js";
import { generateRefreshToken, hashRefreshToken } from "./tokens.js";
import {
  findUserByEmail,
  insertUserIfEmailFree,
  updatePasswordHash,
  type User,
} from "./users.repository.js";

// What may leave the service. password_hash is deliberately not part of this type,
// so a handler cannot serialise it by accident.
export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  status: User["status"];
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
  };
}

export async function registerUser(db: DbExecutor, input: RegisterInput): Promise<PublicUser> {
  // Hash before touching the database: no connection is held during the ~50ms of
  // CPU work, and a duplicate email costs about the same as a success.
  const passwordHash = await hashPassword(input.password);

  const user = await insertUserIfEmailFree(db, {
    email: input.email,
    passwordHash,
    displayName: input.displayName ?? null,
    // MVP: there is no email verification flow yet, so accounts start active.
    // When verification is built, new users start as "pending_verification".
    status: "active",
  });

  // 409: the request is valid but conflicts with existing state. This tells a caller
  // which emails are registered (user enumeration). Accepted trade-off for a usable
  // sign-up form; the mitigation is rate limiting on this route. See ADR-006.
  if (!user) {
    throw new BusinessRuleError(
      "An account with this email already exists",
      "EMAIL_ALREADY_REGISTERED",
    );
  }

  return toPublicUser(user);
}

export interface LoginContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface LoginResult {
  user: PublicUser;
  accessToken: string;
  // Goes into an HttpOnly cookie only; the route must never put it in the JSON body.
  refreshToken: string;
  // Access token lifetime in seconds, so the client knows when to refresh.
  expiresIn: number;
}

const MAX_DEVICE_INFO_LENGTH = 255;

export async function loginUser(
  db: DbExecutor,
  input: LoginInput,
  context: LoginContext,
  settings: Config["auth"],
): Promise<LoginResult> {
  const user = await findUserByEmail(db, input.email);

  // Always verify, even for an unknown user (against a dummy hash), so the response
  // time does not reveal whether the email is registered.
  const passwordOk = await verifyPassword(user?.passwordHash, input.password);

  // One message, one code, for "no such user" and "wrong password" (and for an
  // OAuth-only user with no password): the caller learns nothing about which it was.
  if (!user || !passwordOk) {
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }

  // Status is checked only AFTER the password is proven right, so these messages
  // are shown to the account owner and cannot be used to probe for accounts.
  if (user.status === "suspended") {
    throw new PermissionError("This account is suspended", "ACCOUNT_SUSPENDED");
  }
  if (user.status === "pending_verification") {
    throw new PermissionError("Verify your email before signing in", "EMAIL_NOT_VERIFIED");
  }

  const refreshToken = generateRefreshToken();
  const now = new Date();
  const session = await insertSession(db, {
    userId: user.id,
    refreshTokenHash: hashRefreshToken(refreshToken), // the raw token is never stored
    deviceInfo: context.userAgent?.slice(0, MAX_DEVICE_INFO_LENGTH) ?? null,
    // Guard the inet column: only store something Postgres will accept.
    ipAddress: context.ipAddress && isIP(context.ipAddress) ? context.ipAddress : null,
    expiresAt: new Date(now.getTime() + settings.refreshTokenTtlSeconds * 1000),
    lastUsedAt: now,
  });

  // We hold the plaintext only now, so this is the one chance to upgrade an old hash.
  if (user.passwordHash && needsRehash(user.passwordHash)) {
    await updatePasswordHash(db, user.id, await hashPassword(input.password));
  }

  const accessToken = await signAccessToken(
    { userId: user.id, sessionId: session.id },
    settings,
  );

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken,
    expiresIn: settings.accessTokenTtlSeconds,
  };
}
