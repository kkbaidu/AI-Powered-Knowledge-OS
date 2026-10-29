import { z } from "zod";

// Password policy follows NIST SP 800-63B: length matters, composition rules
// ("one uppercase, one symbol") do not. Passwords are never trimmed or otherwise
// altered, because the user must be able to type back exactly what they set.
// The maximum is a DoS bound: hashing is deliberately expensive, so an unbounded
// password would let one request burn arbitrary CPU.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Normalised here, once, at the edge: everything downstream (service, DB, tests)
// sees a trimmed lowercase email. The DB also enforces case-insensitive uniqueness
// (lower(email) unique index); this keeps stored values consistent with that.
// 254 is the maximum length of a valid email address (RFC 5321).
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

// Unknown keys (say, "status": "active") are stripped, not accepted: a client can
// never set a field we did not list. That is the defence against mass assignment.
export const registerBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100).optional(),
});

export type RegisterInput = z.output<typeof registerBody>;

// Login deliberately does NOT enforce the registration length rules: the policy may
// tighten over time and older accounts must still be able to sign in. It only bounds
// the size (same DoS reasoning as above) and requires something to be present.
export const loginBody = z.object({
  email,
  password: z.string().min(1, "is required").max(PASSWORD_MAX_LENGTH),
});

export type LoginInput = z.output<typeof loginBody>;
