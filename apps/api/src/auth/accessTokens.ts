import { SignJWT, errors, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { AuthError } from "../types/errors.js";

// Only the settings these functions need, so tests and callers pass plain values.
export type AccessTokenSettings = Pick<
  Config["auth"],
  "accessTokenSecret" | "accessTokenTtlSeconds"
>;

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

const ISSUER = "atlas-api";
const AUDIENCE = "atlas-api";
// Pinned on both sign and verify. If verify accepted whatever the token header says,
// an attacker could pick the algorithm ("alg confusion", or the historic alg=none bug).
const ALGORITHM = "HS256";

const keyFor = (secret: string) => new TextEncoder().encode(secret);

// Stateless: anyone holding the secret can verify it with no database lookup. That is
// the whole point, and also why it cannot be revoked and has a short lifetime.
// `sub` is the user, `sid` ties the token to a sessions row so a later check (or a
// "log out everywhere") can still reason about it. No email or roles go in the token:
// it would be stale for up to 15 minutes after they change, and a JWT is readable by anyone.
export async function signAccessToken(
  claims: AccessTokenClaims,
  settings: AccessTokenSettings,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + settings.accessTokenTtlSeconds)
    .sign(keyFor(settings.accessTokenSecret));
}

// `currentDate` exists so tests can check expiry without sleeping.
export async function verifyAccessToken(
  token: string,
  settings: Pick<AccessTokenSettings, "accessTokenSecret">,
  currentDate?: Date,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, keyFor(settings.accessTokenSecret), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "sid", "exp"],
      currentDate,
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new AuthError("Invalid access token", "INVALID_ACCESS_TOKEN");
    }
    return { userId: payload.sub, sessionId: payload.sid };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // A distinct code lets the client tell "refresh and retry" from "log in again".
    if (err instanceof errors.JWTExpired) {
      throw new AuthError("Access token expired", "ACCESS_TOKEN_EXPIRED");
    }
    throw new AuthError("Invalid access token", "INVALID_ACCESS_TOKEN");
  }
}
