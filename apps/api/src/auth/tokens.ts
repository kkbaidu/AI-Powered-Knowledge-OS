import { createHash, randomBytes } from "node:crypto";

// 32 random bytes = 256 bits from the OS CSPRNG. Not derived from anything, so it
// cannot be guessed or computed; it is only valid because we issued it.
const REFRESH_TOKEN_BYTES = 32;

// Opaque on purpose (not a JWT): it carries no data, so there is nothing to decode,
// forge or leak. Its meaning lives in the sessions table, which is also what makes it
// revocable. base64url is safe in cookies and URLs without escaping (43 chars).
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

// SHA-256 (hex, 64 chars) is stored in sessions.refresh_token_hash; the raw token is
// returned to the client once and never persisted. A leaked database then contains
// nothing that can be sent as a cookie.
//
// Why a fast hash is fine here but wrong for passwords: passwords are low-entropy, so
// an attacker can try billions of likely guesses and a slow, memory-hard hash is the
// only defence. A 256-bit random token has nothing to guess, so brute force is
// infeasible however fast the hash is. It also must be deterministic (no salt) so the
// refresh endpoint can look the session up by hash with an indexed equality query.
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
