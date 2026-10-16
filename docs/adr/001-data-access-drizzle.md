# ADR-001: Data access with Drizzle ORM (node-postgres)

Status: Accepted · Date: 2026-10-16

## Context
Atlas needs strong relational integrity (identity, RBAC, tenancy) and pgvector for
retrieval later. I want to stay close to SQL so I can explain every query and
migration, and the vector features must not fight the tooling.

## Decision
Drizzle ORM on the `pg` driver. Schema lives in TypeScript (`src/db/schema/`),
`drizzle-kit generate` emits plain SQL migrations that are committed and reviewed,
and `drizzle-kit migrate` applies them. One shared `pg` Pool (`infra/postgres.ts`)
serves both Drizzle and the health check. Extensions are enabled by a custom
migration (`0000_enable_pgvector.sql`), because they are not part of the schema file.

## Alternatives considered
- **Prisma**: best DX, but pgvector is an `Unsupported` type, so the core retrieval
  feature would live in `$queryRaw` anyway, and the client hides the SQL I want to learn.
- **Kysely**: excellent query builder but no migration tooling, and it would duplicate
  Drizzle's query layer (two sources of truth for types). Rejected, not combined.
- **Raw `pg` + SQL files**: maximum control, but hand-maintained row types and mapping.

## Consequences
- (+) The schema file is the types; migrations are readable SQL; native `vector` column.
- (+) Complex queries (hybrid search) can drop to the `sql` template tag.
- (−) Younger ecosystem and less battle-tested migration tooling than Prisma.
- (−) `$onUpdate` for `updated_at` runs in Drizzle only, so raw SQL updates bypass it.
- `drizzle-kit push` is not used: it applies schema changes with no migration history.

## Interview notes
- *Why a Pool, not a Client?* Each request borrows and returns a connection, so
  concurrent requests do not serialize or pay a connect + auth handshake each time.
- *Why `max: 10`?* Postgres has a hard connection cap (default 100). Instances x `max`
  must stay below it; beyond that you need a pooler such as PgBouncer.
- *Why `connectionTimeoutMillis`?* Fail fast when the DB is down instead of hanging requests.
- *Why a pool `error` listener?* An idle client erroring emits `error` on the pool; with
  no listener Node treats it as an uncaught exception and the process crashes.
