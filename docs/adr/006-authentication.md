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

## Known limitations / follow-ups
- No rate limiting yet (login and register are brute-force and enumeration targets).
- No breached-password check.
- Hash-then-insert means a duplicate registration still pays the hashing cost; that is intentional, it keeps timings similar.
