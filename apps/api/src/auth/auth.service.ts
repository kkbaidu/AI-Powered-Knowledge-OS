import { isIP } from "node:net";
import type { Config } from "../config.js";
import type { DbExecutor } from "../db/client.js";
import { AuthError, BusinessRuleError, PermissionError } from "../types/errors.js";
import { signAccessToken } from "./accessTokens.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { logger } from "../logger.js";
import {
  findSessionByPreviousHash,
  insertSession,
  revokeSession,
  rotateSession,
} from "./sessions.repository.js";
import { generateRefreshToken, hashRefreshToken } from "./tokens.js";
import {
  findUserByEmail,
  findUserById,
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

// Same shape as a login: a new access token and a new refresh token for the same session.
export type RefreshResult = LoginResult;

// Rotation with reuse detection (diagram 3 in docs/architecture).
//
//   presented token == session's CURRENT hash   -> rotate: issue a new pair
//   presented token == session's PREVIOUS hash  -> it was already used:
//        just rotated (< grace)  -> reject, keep the session (two tabs, a retry)
//        rotated longer ago      -> assume theft: revoke the whole session
//   anything else                               -> reject
//
// Why revoking the session is right: whoever holds the old token is either the thief or
// the real user, and we cannot tell which. Killing the session forces a fresh login (the
// real user has the password, the thief does not) and invalidates the newest token the
// other party is holding. Known limit: only ONE previous hash is stored, so a token two
// rotations old matches nothing and is rejected without a revoke.
export async function refreshSession(
  db: DbExecutor,
  presentedToken: string,
  settings: Config["auth"],
): Promise<RefreshResult> {
  const presentedHash = hashRefreshToken(presentedToken);
  const newToken = generateRefreshToken();
  const now = new Date();

  const session = await rotateSession(db, {
    currentHash: presentedHash,
    newHash: hashRefreshToken(newToken),
    now,
    // Sliding expiry: an active session keeps living; one idle for the full TTL dies.
    expiresAt: new Date(now.getTime() + settings.refreshTokenTtlSeconds * 1000),
  });

  if (!session) {
    await rejectUnrotatableToken(db, presentedHash, now, settings);
    // rejectUnrotatableToken always throws; this satisfies the type checker.
    throw new AuthError("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  // The session is valid, but the account may have been suspended since login.
  // Checked after rotation (rotation is the atomic claim); a blocked user loses the session.
  const user = await findUserById(db, session.userId);
  if (!user || user.status !== "active") {
    await revokeSession(db, session.id);
    throw new PermissionError("This account is not active", "ACCOUNT_SUSPENDED");
  }

  return {
    user: toPublicUser(user),
    accessToken: await signAccessToken({ userId: user.id, sessionId: session.id }, settings),
    refreshToken: newToken,
    expiresIn: settings.accessTokenTtlSeconds,
  };
}

async function rejectUnrotatableToken(
  db: DbExecutor,
  presentedHash: string,
  now: Date,
  settings: Config["auth"],
): Promise<never> {
  const replayed = await findSessionByPreviousHash(db, presentedHash);

  // Unknown token, or its session is already revoked or expired: nothing to protect.
  if (!replayed || replayed.revoked || replayed.expiresAt <= now) {
    throw new AuthError("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  // last_used_at is set on every rotation, so it is when this token was replaced.
  const rotatedAt = replayed.lastUsedAt ?? replayed.createdAt;
  const ageSeconds = (now.getTime() - rotatedAt.getTime()) / 1000;

  if (ageSeconds < settings.refreshReuseGraceSeconds) {
    // Almost certainly a concurrent request or a retry. The real user's browser already
    // holds the new cookie, so a retry succeeds. We do not revoke, and we hand out
    // nothing, so a thief replaying inside the window gains nothing.
    throw new AuthError("Refresh token was just rotated, retry", "REFRESH_TOKEN_ROTATED");
  }

  await revokeSession(db, replayed.id);
  logger.warn(
    { userId: replayed.userId, sessionId: replayed.id, ageSeconds: Math.round(ageSeconds) },
    "Refresh token reuse detected, session revoked",
  );
  throw new AuthError("Refresh token reuse detected", "REFRESH_TOKEN_REUSED");
}
