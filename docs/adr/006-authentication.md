# ADR-006: Authentication

Status: Accepted · Date: 2026-10-29 · Reviewed: 2026-11-24
Related: ADR-002 (identity schema), ADR-003 (config and errors), ADR-004 (request pipeline)

## Context

Atlas needs email and password sign-in for a browser app, with several devices per user,
revocable sessions, and protection against the usual attacks on a login endpoint (guessing,
credential stuffing, enumeration, token theft). The API is a single Express service in front
of Postgres and Redis. No email delivery, OAuth or MFA exists yet.

## Overview

| Endpoint | Credential | Protections |
|---|---|---|
| `POST /auth/register` | none | 4 KB body cap, Zod validation, 10 per hour per IP |
| `POST /auth/login` | none | 4 KB body cap, validation, 30 per 15 min per IP, 5 per 15 min per IP + email (cleared on success) |
| `POST /auth/refresh` | refresh cookie | atomic rotation, reuse detection |
| `POST /auth/logout` | refresh cookie | idempotent, always 204 |
| `POST /auth/logout-all` | Bearer access token, session checked | revokes every session of the user |
| `GET /auth/me` | Bearer access token | re-reads the user, enforces status |

Tokens: a 15 minute HS256 access JWT returned in the JSON body (kept in memory by the
client), and a 30 day opaque refresh token in an HttpOnly cookie. The server stores only a
SHA-256 hash of the refresh token.

## Threat model

| Threat | Defence | Proven by |
|---|---|---|
| Stolen database | Argon2id password hashes; refresh tokens stored only as SHA-256 | `passwords.test.ts`, `login.integration.test.ts` |
| Online password guessing | Per IP + email limit, atomic in Redis | `rate-limit.integration.test.ts` (parallel guesses: exactly the allowed number get through) |
| Credential stuffing | Per IP limit across all emails; success does not refund it | `rate-limit.integration.test.ts` |
| Locking a victim out | The per-account limit is keyed on IP too | `rate-limit.integration.test.ts` |
| Account enumeration | One 401 for unknown email, wrong password and OAuth-only; dummy hash equalises timing; status shown only after the password is proven | `login.integration.test.ts` |
| Refresh token theft | Rotation on every use; replay of the old token revokes the session | `refresh.integration.test.ts` |
| Two tabs refreshing at once | Atomic `UPDATE ... WHERE`, grace period for the loser | `refresh.integration.test.ts` (6 parallel: one wins, session survives) |
| JWT forgery or confusion | Algorithm, issuer, audience and required claims pinned; `alg: none` and other algorithms rejected | `accessTokens.test.ts` |
| XSS stealing a session | Refresh token HttpOnly and not in the body; access token only in memory | `login.integration.test.ts` |
| CSRF | `SameSite=Strict` cookie scoped to `/api/v1/auth`; Bearer tokens come from the header only, never a cookie | `login.integration.test.ts`, `requireAuth.test.ts` |
| Spoofing the client IP to dodge limits | `X-Forwarded-For` ignored unless a proxy hop count is configured | `rateLimit.test.ts`, `rate-limit.integration.test.ts` |
| Secrets in logs | Redaction by field name, plus rewriting of database errors | `errorHandler.test.ts` |
| Oversized unauthenticated requests | 4 KB cap on the auth routes before the general 1 MB parser | `app.test.ts` |

## Decisions

### Credentials and tokens

| Area | Decision | Why |
|---|---|---|
| Password hashing | Argon2id via `@node-rs/argon2`, OWASP minimum (19 MiB, 2 passes, 1 lane), parameters written out in `ARGON2_POLICY` | Memory-hard, so GPU and ASIC cracking is expensive. Prebuilt binaries mean no compiler in Docker or CI. A library upgrade cannot silently change the policy. |
| Rehash | `needsRehash` compares a stored hash to the policy; login upgrades it | Parameters live inside every hash, so they can be raised without a forced reset. The plaintext exists only at login. |
| Password policy | 12 to 128 characters, no composition rules, never trimmed | NIST 800-63B: length beats complexity rules. The maximum bounds hashing cost (DoS). |
| Email | Trimmed, lowercased, max 254, ASCII only (Zod); looked up with `lower(email) = $1` | One normalisation point at the edge, consistent with the `lower(email)` unique index, which only that query form can use. |
| Access token | JWT via `jose`, HS256, 15 minutes, claims `sub`, `sid`, `iss`, `aud`, `iat`, `exp` only | Verified with no database read. No email or roles inside: it is readable by anyone and stale for up to 15 minutes. |
| Secret | `JWT_ACCESS_SECRET`, 32 character minimum, no default | A built-in secret would be a known secret. Checked at boot. |
| Refresh token | 32 random bytes (base64url), opaque, SHA-256 stored | Nothing to decode or forge, and revocable through the `sessions` row. A fast hash is safe here because a 256-bit random value cannot be brute-forced, unlike a password. It must be unsalted so it can be found by an indexed equality lookup. |
| TTLs | Access 900 s, refresh 2,592,000 s, refresh must exceed access | Validated at boot. |

### Registration

| Area | Decision | Why |
|---|---|---|
| Scope | Creates the user only, with status `active` | Organizations come later. No verification flow exists, so accounts cannot start as `pending_verification` yet. |
| Duplicates | `INSERT ... ON CONFLICT DO NOTHING RETURNING`, no prior SELECT | Check-then-insert races. The database arbitrates: 5 parallel requests give one 201 and four 409. |
| Duplicate response | 409 `EMAIL_ALREADY_REGISTERED` | Reveals which emails exist. Accepted for sign-up usability and mitigated by the register rate limit. The alternative, a generic "check your email" reply, needs the email flow. |
| Mass assignment | Zod strips unknown keys; the insert lists its fields | A client can never set `status` or `id`. |
| Output | `PublicUser` omits `passwordHash` | A handler cannot serialise the hash by accident. |

### Login

| Area | Decision | Why |
|---|---|---|
| Errors | 401 `INVALID_CREDENTIALS` for every credential failure | The caller cannot tell which case it was. |
| Timing | `verifyPassword` always runs, against a dummy hash if the user is unknown | An unknown email would otherwise answer in microseconds instead of about 50 ms. |
| Status | Suspended and unverified users get 403, but only after the password is correct | The status is shown only to someone who proved ownership of the account. |
| Session | One `sessions` row per login (multi-device): token hash, user agent (max 255), IP (only if it parses) | `previous_token_hash` stays null until the first rotation. |
| Caching | `Cache-Control: no-store` on every auth response | Responses carry tokens. |

### Sessions: refresh, logout

| Area | Decision | Why |
|---|---|---|
| Rotation | One atomic `UPDATE sessions SET previous_token_hash = refresh_token_hash, refresh_token_hash = $new ... WHERE refresh_token_hash = $old AND NOT revoked AND expires_at > now() RETURNING` | Two requests with the same token race for the row lock. The loser re-checks the `WHERE` against the updated row and gets zero rows. SELECT-then-UPDATE would let both pass. |
| Reuse | Old token replayed after the grace period: revoke the whole session (401 `REFRESH_TOKEN_REUSED`) | The holder of the old token is the thief or the user and we cannot tell which. Revoking kills the newest token the other party holds and forces a login only the real user can complete. Other sessions are untouched. |
| Grace period | `REFRESH_REUSE_GRACE_SECONDS`, default 10. Inside it: 401 `REFRESH_TOKEN_ROTATED`, session kept, nothing issued. 0 disables it. | Two tabs refreshing at once are not theft. Without it the race logs legitimate users out (tested). A replay inside the window is not detected, but gains the thief nothing since no token is issued. |
| Rotation time | `last_used_at` doubles as "when this token was last rotated" | No migration needed. It must not be updated by anything else. A dedicated `rotated_at` is cleaner if that changes. |
| Expiry | Sliding: each rotation sets `expires_at` to now plus the refresh TTL and re-issues the cookie | Active users stay signed in. An absolute lifetime cap is a follow-up. |
| Account status | Checked after rotation; a suspended user loses the session (403) | Rotation is the atomic claim, so the status check cannot race it. |
| Logout | Always 204 and the cookie is cleared, with or without a valid token. Revokes the session matching the current or previous hash. | Idempotent and safe to retry; reveals nothing about which tokens exist. A logout racing a refresh carries the previous token and must still work. |
| Log out everywhere | One `UPDATE ... WHERE user_id = $1 AND NOT revoked`, returns the count | Single statement using `sessions_user_id_idx`. |

### Cookies and transport

| Area | Decision | Why |
|---|---|---|
| Refresh cookie | `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` in production, `Max-Age` = refresh TTL | Strict is the CSRF defence for `/auth/refresh`; the path keeps the cookie off every other request. If the web app ever lives on a different registrable domain than the API, Strict stops working and a CSRF token is needed. |
| Clearing | Repeats the same path and flags | A clear with different attributes targets a different cookie. |
| When to clear | On a 401 or 403 from refresh, **except** `REFRESH_TOKEN_ROTATED`, and never on a 5xx | A dead token should be dropped. A database blip must not log everyone out. The loser of a rotation race must not clear the cookie the winner just set (see review findings). |
| Token source | Refresh token: cookie only (a small parser, no dependency). Access token: `Authorization: Bearer` only, never the query string or a cookie. | URLs leak into logs and `Referer`. Cookies are attached automatically, which would reopen CSRF on every API route. |

### Auth middleware

| Area | Decision | Why |
|---|---|---|
| Two modes | `requireAuth(deps)` trusts the signed token. `requireAuth(deps, { checkSession: true })` also reads the session and user. | The central trade-off. Stateless: no database read, but a revoked or suspended user keeps access for up to 15 minutes. Strict: one indexed read per request buys instant revocation. Default stateless; opt in where staleness is unacceptable (`/logout-all` now; account changes, billing and admin later). |
| Strict checks | Session exists, belongs to the token's `sub`, not revoked, not expired, user `active` | Missing, revoked and expired all answer `SESSION_REVOKED`. |
| Errors | `AUTH_REQUIRED`, `ACCESS_TOKEN_EXPIRED` (refresh and retry), `INVALID_ACCESS_TOKEN` and `SESSION_REVOKED` (log in again), 403 `ACCOUNT_SUSPENDED`, plus an RFC 6750 `WWW-Authenticate` challenge | Clients branch on the code. |
| Caller identity | `res.locals.auth` via `getAuth(res)`, which throws a 500 if a route forgot the middleware | A missing guard is a loud bug, never an anonymous caller. |
| `/auth/me` | Stateless check, then reads the user and refuses non-active accounts | The handler reads the database anyway, so status comes for free. |

### Rate limiting

| Area | Decision | Why |
|---|---|---|
| Algorithm | Sliding window log: a Redis sorted set of timestamps, one Lua script per check | A fixed-window counter allows 2x the limit across a window boundary, which matters for "5 password guesses". The log is exact and bounded by the limit, because only allowed requests are stored. For high volumes use a sliding window counter or a token bucket. |
| Atomicity and time | Check and count in one script; time from Redis `TIME` | Redis does not interleave other commands during a script: 60 parallel requests against a limit of 10 let exactly 10 through. API servers with skewed clocks still agree. |
| Blocked requests | Not recorded | Hammering a blocked key cannot extend its own lockout. |
| Login limits | 5 per 15 min per IP **and** email (cleared by a successful login); 30 per 15 min per IP | The pair limit is the brute-force brake and cannot lock a victim out. The IP limit stops credential stuffing and leaves room for an office NAT. Success clears only the pair budget, so a script cannot refund its IP budget by logging into an account it owns. |
| Not shipped | A limit on the email alone | It would stop distributed attacks on one account, but any stranger could then lock anyone out. A product decision (CAPTCHA, step-up checks, alerts), not a default. |
| Not limited | `/refresh`, `/logout`, `/me` | They need a 256-bit token or a signed JWT, so there is nothing to guess. |
| Order | After validation, before any password work | A throttled caller costs one Redis call, not an Argon2 hash. Invalid requests do not consume budget, which is why the body cap matters. |
| Redis outage | Fail **open**, logged at `error` | Failing closed turns a Redis outage into a login outage. The cost is no brute-force brake meanwhile; Argon2 cost and alerting on that log line are the backstop. |
| Client IP | `req.ip` with `TRUST_PROXY_HOPS` (default 0) | With 0, `X-Forwarded-For` is ignored and cannot be used to dodge a limit. Behind a real proxy the hop count must be set, otherwise every user shares the proxy's address. |
| Keys | `rl:<rule>:<ip>[:<sha256(email) prefix>]` | No raw email in Redis; bounded key length. |
| Response | 429 `RATE_LIMITED` with `Retry-After` | Standard header, plus `details.retryAfterSeconds`. |

### Structure and testing

| Area | Decision | Why |
|---|---|---|
| Dependency injection | `createApp` receives `auth` settings and a `RateLimiter` | Tests build apps with their own settings; importing config has side effects (it can exit the process). In-memory and no-op limiters keep unit tests free of Redis. |
| Real services | Integration tests run against real Postgres and Redis | The guarantees that matter (row locks, Lua atomicity, unique indexes) do not exist in a mock. |
| Coverage | `pnpm test:coverage` runs unit and integration together | At the review: auth module 100% of lines, 94% of branches. |

## Review pass (2026-11-24)

An independent reviewer read the module without seeing these notes, and each finding was
checked against the code before acting. Each fix has a regression test that fails without it.

| # | Finding | Impact | Fix |
|---|---|---|---|
| 1 | `/refresh` cleared the cookie on `REFRESH_TOKEN_ROTATED` too | The loser of a benign two-tab race could overwrite the winner's new cookie and log the user out | Skip the clear for that code |
| 2 | Drizzle's error message embeds the SQL parameters, and the error handler logged it | A database blip during register wrote the plaintext email and the Argon2 hash to the logs. Field-name redaction cannot see values inside a message. | `loggableError` keeps the SQL text, SQLSTATE and driver message, drops parameters and Postgres `detail` |
| 3 | Body-parser errors other than `entity.*` (unsupported charset or `Content-Encoding`, aborted request) became 500s | Anyone could trigger error-level logs and alerts | Any 4xx body-parser error is a client error (415 or 422) |
| 4 | Only a 1 MB body cap on the unauthenticated routes | Cheap to burn parsing time; invalid requests never consume rate-limit budget | 4 KB cap on `/api/v1/auth`, with a test that the worst legitimate body is under half of it |

Discarded after checking: alg confusion, token-type confusion, rotation and logout races,
suspended-user access, login timing, SQL injection, Redis key injection, cookie flags,
logger header leaks.

## Known limitations and follow-ups

- If the response that carried a rotated token is lost (the client still holds the old one), a retry after the grace period looks like theft and ends the session. Inherent to rotation; the grace period only covers short gaps.
- Only one previous hash is stored. A token two rotations old is rejected but the session is not revoked. Fix: a token family id or a history table.
- Sliding expiry has no absolute cap, so a session that is used often never expires.
- A distributed attack on one account is throttled only by Argon2 cost (see "Not shipped").
- IPv6 clients are limited per full address; an attacker with a /64 can rotate. Limit by prefix if that appears.
- Concurrent hashing runs on the libuv thread pool (4 threads by default) and each hash needs 19 MiB. Size `UV_THREADPOOL_SIZE` and container memory for peak login load.
- No password change or reset flow yet. When it exists it must revoke all sessions.
- No endpoint lists a user's devices, and nothing revokes one other session by id. No per-user session cap, and no job that deletes expired or revoked session rows.
- No breached-password check, no email verification, no MFA.
- CORS and security headers are not configured. They are needed before a browser on another origin can use the cookie flow (`credentials` plus an exact origin).
- No metrics on 429s or limiter failures. The `Rate limiter unavailable` log line should alert.
- A duplicate registration still pays the hashing cost. Intentional: it keeps timings similar.
