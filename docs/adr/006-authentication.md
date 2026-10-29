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

## Auth middleware, `/auth/me`, log out everywhere

| Area | Decision | Why |
|---|---|---|
| Token source | `Authorization: Bearer` header only. Never the query string, never a cookie. | URLs leak into logs, history and `Referer`. Cookies are attached automatically by browsers, which would reopen CSRF on every API route. Tested. |
| Two modes | `requireAuth(deps)` trusts the signed token. `requireAuth(deps, { checkSession: true })` also reads the session and user. | The real trade-off. Stateless: no database read, but a revoked or suspended user keeps access for up to 15 minutes. Strict: one indexed read per request buys instant revocation. Default to stateless and opt in where staleness is unacceptable. |
| Where strict is used | `/auth/logout-all` now. Account changes, billing and admin routes later. | A destructive account-level action should not be callable with a token from an ended session. |
| Strict checks | Session exists, belongs to the token's `sub`, not revoked, not expired, and the user is `active` | The `sub`/`sid` binding is enforced even though a token cannot be forged without the secret. Missing, revoked and expired all give the same `SESSION_REVOKED`. |
| Error contract | `AUTH_REQUIRED` (nothing usable sent), `ACCESS_TOKEN_EXPIRED` (refresh and retry), `INVALID_ACCESS_TOKEN` and `SESSION_REVOKED` (log in again), `ACCOUNT_SUSPENDED` (403) | Clients can branch on the code. RFC 6750 `WWW-Authenticate: Bearer` challenge on every 401. |
| Caller identity | `res.locals.auth`, read through `getAuth(res)` | Same pattern as `res.locals.validated`. `getAuth` throws a 500 if a route forgot the middleware, so a missing guard is a loud bug rather than an anonymous caller. |
| `/auth/me` | Stateless token check, then reads the user and refuses non-active accounts | The handler reads the database anyway, so status is enforced for free. |
| `/auth/logout-all` | One `UPDATE ... WHERE user_id = $1 AND NOT revoked`, returns the count, clears the cookie | Single statement, uses `sessions_user_id_idx`. |

## Rate limiting

| Area | Decision | Why |
|---|---|---|
| Algorithm | Sliding window log: a Redis sorted set of request timestamps, one Lua script per check | A fixed-window counter (`INCR` + `EXPIRE`) allows 2x the limit across a window boundary, which matters for "5 password guesses". The log is exact, and its memory is bounded by the limit because only allowed requests are stored. For high-volume limits (thousands per window) use a sliding window counter or a token bucket instead. |
| Atomicity | Check and count happen in one Lua script | Redis runs a script without interleaving other commands. 60 parallel requests against a limit of 10 let exactly 10 through (tested against real Redis). A `GET`-then-`INCR` sequence lets bursts slip under the limit. |
| Time source | `TIME` inside Redis, not the API server | Several API instances with skewed clocks still agree on when a window ends. |
| Blocked requests | Not recorded | Hammering a blocked key cannot extend its own lockout (tested). |
| Login limits | 5 per 15 min per IP **and** email, cleared by a successful login; 30 per 15 min per IP | The per-pair limit is the brute-force brake. Keying it on both means a stranger can only throttle their own address for a victim's email, never lock the victim out (tested). The per-IP limit stops one address spraying many emails (credential stuffing) with room for an office NAT. Success clears only the pair budget, so a script cannot refund its per-IP budget by logging into an account it owns. |
| Not shipped | A limit on the email alone | It would stop distributed attacks on one account, but any stranger could then lock anyone out. This is a product decision (CAPTCHA, step-up checks, alerts), not a default. |
| Register limit | 10 per hour per IP | Slows mass account creation and email enumeration through the 409. |
| Not limited | `/refresh`, `/logout`, `/me` | They need a 256-bit token or a signed JWT, so there is nothing to guess. |
| Order | After validation, before any password work | A throttled caller costs one Redis call, not an Argon2 hash. Requests that fail validation do not consume budget. |
| Redis outage | Fail **open**: allow the request and log at `error` | Failing closed turns a Redis outage into a login outage. The cost is no brute-force brake while Redis is down; Argon2 cost and alerting on that log line are the backstop. Tested. |
| Client IP | `req.ip` with an explicit `TRUST_PROXY_HOPS` (default 0) | With 0 hops `X-Forwarded-For` is ignored, so it cannot be used to dodge a limit (tested). Behind a real proxy the hop count must be set, otherwise every user shares the proxy's address and one person's traffic limits everyone. IPv4-mapped IPv6 addresses are normalised into one bucket. |
| Keys | `rl:<rule>:<ip>[:<sha256(email) prefix>]` | No raw email in Redis, bounded key length. |
| Response | 429 `RATE_LIMITED` with `Retry-After` (seconds) | Standard header; `details.retryAfterSeconds` for clients that prefer the body. |
| Injection | `createApp` takes a `RateLimiter` | Unit tests use an in-memory limiter with a movable clock and need no Redis. A no-op limiter keeps unrelated tests fast. |

## Known limitations / follow-ups
- Only one previous hash is stored. A token two rotations old matches nothing: it is rejected but the session is not revoked (tested and documented). Fix: a `session_token_history` table, or a token family id.
- IPv6 clients are limited per full address. An attacker with a /64 can rotate addresses; limit by /64 prefix if that becomes a problem.
- No limit on a single account across all addresses (see "Not shipped" above). A distributed attack on one account is throttled only by Argon2 cost.
- No metrics yet on 429s or limiter failures; the `Rate limiter unavailable` log line should alert.
- No endpoint lists a user's sessions (devices) yet, and nothing revokes a single other session by id.
- No per-user session cap and no cleanup job for expired sessions yet.
- No breached-password check.
- Hash-then-insert means a duplicate registration still pays the hashing cost; that is intentional, it keeps timings similar.
