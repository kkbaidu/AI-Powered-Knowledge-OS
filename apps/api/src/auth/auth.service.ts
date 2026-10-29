import type { DbExecutor } from "../db/client.js";
import { BusinessRuleError } from "../types/errors.js";
import type { RegisterInput } from "./auth.schemas.js";
import { hashPassword } from "./passwords.js";
import { insertUserIfEmailFree, type User } from "./users.repository.js";

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
