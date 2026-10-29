# ADR-006: Authentication

Status: In progress (Day 3) · Date: 2026-10-29

Grows one step at a time: config and primitives, register, then login, refresh, logout and
the auth middleware. Each step appends its decisions here.

## Config and primitives

| Area | Decision | Why |
|---|---|---|
| Password hashing | Argon2id via `@node-rs/argon2`, OWASP minimum (19 MiB, 2 passes, 1 lane) | Memory-hard, so GPU/ASIC cracking is costly. Prebuilt binaries mean no compiler in Docker or CI. Parameters are explicit in `ARGON2_POLICY`, not library defaults. |
| Rehash on login | `needsRehash` compares the PHC string to the policy | Parameters live inside every hash, so they can be raised later without a forced reset. |
| Timing | Unknown email verifies against a dummy hash | "No such user" and "wrong password" cost the same, so login timing does not reveal registered emails. |
| Access token | JWT via `jose`, HS256, 15 minutes | Verified with no DB hit, so it cannot be revoked: keep it short. `JWT_ACCESS_SECRET` has a 32 character minimum and no default. |
| Refresh token | 32 random bytes (base64url), opaque, stored as SHA-256 | Nothing to decode or forge, and revocable through the `sessions` row. A fast hash is safe because a 256-bit random value cannot be brute-forced, unlike a password. It must also be unsalted so it can be looked up by equality. |
| TTLs | Access 900 s, refresh 2,592,000 s, refresh must exceed access | Validated at boot. |

## Register

| Area | Decision | Why |
|---|---|---|
| Scope | Creates the user only. Organizations come later. | Keeps the first auth endpoint small and testable. |
| Initial status | `active` | No email verification flow exists yet. Switch to `pending_verification` when it does. |
| Password policy | 12 to 128 characters, no composition rules, never trimmed | NIST 800-63B: length beats complexity rules. The maximum bounds the CPU cost of hashing (DoS). |
| Email | Trimmed and lowercased in the Zod schema, max 254 | One normalisation point at the edge, consistent with the `lower(email)` unique index. |
| Duplicate detection | `INSERT ... ON CONFLICT DO NOTHING RETURNING`, no prior SELECT | Check-then-insert races: two simultaneous requests both see "free". The database arbitrates. Tested with 5 parallel requests: one 201, four 409. |
| Duplicate response | 409 `EMAIL_ALREADY_REGISTERED` | Reveals which emails exist (enumeration). Accepted for sign-up usability; mitigated by rate limiting, which is not built yet. The alternative is a generic "check your email" response, which needs the email flow. |
| Mass assignment | Zod strips unknown keys; the insert lists fields explicitly | A client can never set `status` or `id`. |
| Output | `PublicUser` type omits `passwordHash` | A handler cannot serialise the hash by accident. |

## Login

| Area | Decision | Why |
|---|---|---|
| Credential errors | One response (401 `INVALID_CREDENTIALS`) for unknown email, wrong password and OAuth-only accounts | The caller cannot tell which it was. Tested: the two bodies are identical. |
| Timing | `verifyPassword` always runs, against a dummy hash when the user does not exist | An unknown email would otherwise return in microseconds instead of ~50ms. |
| Account status | Suspended and unverified users get 403, but only after the password is correct | The status is shown only to someone who proved they own the account. A wrong password on a suspended account still returns 401. |
| Email lookup | `lower(email) = $1` | The only form that can use the `lower(email)` unique index (ADR-002). |
| Access token | HS256 JWT with `sub`, `sid`, `iss`, `aud`, `iat`, `exp`. Algorithm, issuer, audience and required claims are pinned on verify. | Pinning blocks alg-confusion and `alg: none`. No email or roles in the token: it is readable by anyone and stale for up to 15 minutes. |
| Expiry signalling | `ACCESS_TOKEN_EXPIRED` vs `INVALID_ACCESS_TOKEN` | The client refreshes on the first and re-authenticates on the second. |
| Token delivery | Access token in the JSON body (held in memory); refresh token only in an HttpOnly cookie | XSS cannot read the refresh token. Not in `localStorage`, which any injected script can read. |
| Cookie | `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` in production, `Max-Age` = refresh TTL | Strict is the CSRF defence for `/auth/refresh`. The path keeps the cookie off every other request. If the web app ever lives on a different registrable domain than the API, Strict stops working and a CSRF token is needed. |
| Caching | `Cache-Control: no-store` on every auth response | Responses carry tokens. |
| Session row | One row per login (multi-device). Stores the token hash, a user-agent (max 255) and the IP (only if it parses as an IP). | `previous_token_hash` stays null until the first rotation. |
| Rehash | Weaker stored hashes are upgraded after a successful login | The plaintext exists only at that moment. |
| Dependency injection | `createApp` takes `auth` settings instead of importing config | Tests build apps with their own settings and importing config has side effects (it can exit the process). |

## Refresh (rotation and reuse detection)

| Area | Decision | Why |
|---|---|---|
| Rotation | One atomic `UPDATE sessions SET previous_token_hash = refresh_token_hash, refresh_token_hash = $new ... WHERE refresh_token_hash = $old AND NOT revoked AND expires_at > now() RETURNING` | Two requests with the same token race for the row lock. The loser re-checks the `WHERE` against the updated row and gets zero rows, so exactly one can rotate. SELECT-then-UPDATE would let both pass. Tested with 6 parallel requests: one 200, five rejected. |
| Reuse | Presented token equals `previous_token_hash` and the rotation is older than the grace period: revoke the whole session (401 `REFRESH_TOKEN_REUSED`) | The holder of the old token is the thief or the user and we cannot tell which. Revoking kills the newest token the other party holds and forces a login only the real user can complete. Other sessions of the user are untouched. |
| Grace period | `REFRESH_REUSE_GRACE_SECONDS` (default 10). Inside it: 401 `REFRESH_TOKEN_ROTATED`, session kept, nothing issued. | Two tabs refreshing at once, or a retry after a lost response, are not theft. Without a grace period the race above logs legitimate users out (tested). Cost: a replay inside the window is not detected as theft, but it gains the thief nothing since no token is issued. 0 disables it. |
| Rotation time | `last_used_at` doubles as "when this token was last rotated" | No migration needed. It must not be updated by anything else, or grace checks drift. A dedicated `rotated_at` is cleaner if that changes. |
| Expiry | Sliding: every rotation sets `expires_at` to now plus the refresh TTL, and the cookie is re-issued | Active users stay signed in. Absolute lifetime cap is a follow-up. |
| Account status | Checked after rotation. A suspended user loses the session (403). | Rotation is the atomic claim; the status check cannot race it. |
| Cookie on failure | A 401 or 403 clears the cookie; a 5xx does not | A dead token should be dropped. A database blip must not log everyone out. |
| Token source | Cookie only (a 40-line parser, no dependency). The body and the `Authorization` header are ignored (tested). | Keeps the token out of anything that gets logged or cached, and keeps `SameSite=Strict` meaningful. |
| Logging | Reuse is logged at `warn` with user and session ids, never the token | Theft signals need to be visible to operators. |

## Logout

| Area | Decision | Why |
|---|---|---|
| Response | Always 204 with no body, and the cookie is cleared, whether or not a valid token was sent | Idempotent and safe to retry. Nothing is revealed about which tokens exist. The goal state ("this token no longer works") already holds when the token is unknown. |
| Matching | Revokes the session whose CURRENT or PREVIOUS hash matches | A logout that races a refresh carries the previous token. Matching only the current one would silently do nothing. Possessing either token is already enough to hold the session. |
| Scope | One session (this device). Other sessions are untouched (tested). | Matches what "log out" means on one device. "Log out everywhere" needs the authenticated user, so it comes with the auth middleware. |
| Cookie clearing | Same `path`, `secure` and `sameSite` as when it was set | A clear with different attributes targets a different cookie and the browser keeps the real one. Tested. |
| Access token | Not invalidated. It stays valid until it expires (at most 15 minutes). A test documents this. | Verifying it never reads the database, which is the reason to use a JWT at all. Instant revocation needs a per-request session lookup; see the middleware decision. |
| CSRF | No extra token | `SameSite=Strict` stops cross-site requests from carrying the cookie, and a forged logout only signs the user out. |

## Known limitations / follow-ups
- Only one previous hash is stored. A token two rotations old matches nothing: it is rejected but the session is not revoked (tested and documented). Fix: a `session_token_history` table, or a token family id.
- No rate limiting yet. Login is the main brute-force target and register an enumeration target. Needs a Redis-backed limiter per IP and per email.
- `req.ip` is the socket address. Behind a load balancer it is the proxy's address until `trust proxy` is configured.
- No per-user session cap and no cleanup job for expired sessions yet.
- No breached-password check.
- Hash-then-insert means a duplicate registration still pays the hashing cost; that is intentional, it keeps timings similar.
