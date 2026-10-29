import { Algorithm, hash, parseOptions, verify } from "@node-rs/argon2";

// Argon2id with the OWASP-recommended minimum: 19 MiB of memory, 2 passes, 1 lane.
// Memory-hardness is the point: a GPU or ASIC cracker needs that much RAM per guess, so
// parallel guessing gets expensive. These are written out (not left to library
// defaults) so the policy is visible and a library upgrade cannot silently change it.
// The parameters are embedded in every hash string, so raising them later does not
// break old hashes; see needsRehash.
export const ARGON2_POLICY = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
});

// The salt is generated per hash by the library and stored inside the returned
// PHC string ($argon2id$v=19$m=...,t=...,p=...$salt$hash), so no extra column is needed.
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_POLICY);
}

// A real hash of a throwaway value. Verifying against it costs the same as verifying a
// real user, so "no such user" and "wrong password" take the same time and an attacker
// cannot enumerate emails by timing login. Computed lazily, once per process.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("atlas-timing-equalisation-dummy");
  return dummyHash;
}

// Pass null/undefined when the user does not exist or has no password (OAuth-only):
// the work is still done and the answer is always false.
// A malformed stored hash throws on purpose. That is corrupt data, not a wrong
// password, and the error handler should log it as a 500 instead of hiding it.
export async function verifyPassword(
  storedHash: string | null | undefined,
  plain: string,
): Promise<boolean> {
  if (!storedHash) {
    await verify(await getDummyHash(), plain);
    return false;
  }
  return verify(storedHash, plain);
}

// True when a stored hash was made with weaker parameters than the current policy.
// After a successful login (the only moment the plaintext is available), rehash and
// save, so users migrate to stronger settings without a forced reset.
export function needsRehash(storedHash: string): boolean {
  const p = parseOptions(storedHash);
  return (
    p.algorithm !== ARGON2_POLICY.algorithm ||
    p.memoryCost < ARGON2_POLICY.memoryCost ||
    p.timeCost < ARGON2_POLICY.timeCost ||
    p.parallelism !== ARGON2_POLICY.parallelism
  );
}
