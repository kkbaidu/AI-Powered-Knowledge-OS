# ADR-002: Identity schema and RBAC data model

Status: Accepted · Date: 2026-10-16

## Context
Day 2 delivers the identity domain: `users`, `sessions`, `organizations`, `roles`,
`permissions`, `role_permissions`, `organization_members`. Auth endpoints come later,
so the schema must already support refresh-token rotation and per-organization roles.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Primary keys | `uuid` via `gen_random_uuid()` | Not enumerable, can be generated anywhere. Cost: random v4 keys have poor B-tree locality. UUIDv7 would fix that; revisit if write-heavy tables need it. |
| Table names | Plural (`users`) | `user` is a reserved word in Postgres and would need quoting in raw SQL. |
| Email | `UNIQUE INDEX ON lower(email)` | `A@x.com` and `a@x.com` must be one account. Lookups must use `lower(email) = $1` to hit the index; a plain index on `email` cannot serve a `lower()` expression. |
| Timestamps | `timestamptz` | Stores an absolute UTC instant. Plain `timestamp` has no zone and means different things to different clients. |
| Refresh tokens | Store SHA-256 hash only (`refresh_token_hash`) | A leaked DB must not leak usable tokens. `previous_token_hash` enables reuse (theft) detection after rotation. |
| Session indexes | unique on `refresh_token_hash`; indexes on `previous_token_hash`, `user_id`, `expires_at` | Refresh lookup, reuse detection, "revoke all my sessions", and expired-session cleanup. |
| Role scoping | Default roles are **copied into each org** at creation (`provisionDefaultRoles`) | Allows per-org customization. Cost: changing the defaults later means migrating every existing org. Alternative: system roles with `organization_id NULL`. |
| Permissions | Global catalogue seeded as data (`resource.action` names) | RBAC is data, not code: roles can change without a deploy. |
| Seeding | `INSERT ... ON CONFLICT DO UPDATE` | Idempotent: running twice never duplicates rows. |

## Foreign key `ON DELETE` choices

| FK | Behavior | Reason |
|---|---|---|
| `sessions.user_id` | CASCADE | A session means nothing without its user. |
| `organizations.owner_id` | RESTRICT | Deleting an owner is a conscious act: transfer ownership first. |
| `roles.organization_id` | CASCADE | Roles belong to the org. |
| `organization_members.organization_id` / `.user_id` | CASCADE | A membership means nothing without either side. |
| `organization_members.role_id` | RESTRICT | A role cannot be deleted while members hold it. |
| `role_permissions.*` | CASCADE | Pure join rows. |

CASCADE is dangerous where deletion should be deliberate: one `DELETE` can silently
remove large subtrees (a deleted org takes its roles, memberships, and later its
documents). It is used here only where the child has no independent meaning.

## Known limitations / follow-ups
- `updated_at` is maintained by Drizzle (`$onUpdate`), not a DB trigger.
- `sessions.ip_address` is personal data under GDPR-style rules; decide retention before launch.
- Hard deletes for users for now; consider soft delete (`deleted_at`) when audit needs appear.
- Verified against a real Postgres 16: duplicate emails differing by case are rejected,
  RESTRICT/CASCADE behave as above, and provisioning is idempotent (44 role-permission
  rows after any number of runs: Owner 17, Admin 15, Developer 7, Member 3, Viewer 2).
