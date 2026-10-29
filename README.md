# Atlas — AI-Powered Knowledge OS

A multi-tenant knowledge platform: upload documents, search them with hybrid retrieval, and chat with citations. Built as a learning project, so every non-obvious decision is written down as an ADR.

**Status:** Phase 0 complete (foundation). Identity schema, RBAC data model, request pipeline and CI are done. Authentication endpoints are next. See [docs/architecture](docs/architecture/) for what exists versus what is planned.

## Stack

Node 22 · TypeScript · Express 5 · PostgreSQL 16 + pgvector · Drizzle ORM · Redis · Zod · pino · Vitest · pnpm workspaces · GitHub Actions

## Quick start

Requires Node 22+, pnpm, and Docker.

```bash
pnpm install
cp .env.example .env                          # local dev values, safe to use as-is
docker compose up -d postgres redis
pnpm --filter @atlas/api db:migrate           # creates the schema and enables pgvector
pnpm --filter @atlas/api db:seed              # seeds the permission catalogue (idempotent)
pnpm dev                                      # API on http://localhost:4000
```

Check it is up:

```bash
curl localhost:4000/api/v1/health/live        # process is alive
curl localhost:4000/api/v1/health/ready       # Postgres and Redis reachable
```

## Scripts (run from the repo root with `pnpm --filter @atlas/api <script>`)

| Script | What it does |
|---|---|
| `dev` | API with hot reload |
| `lint` / `typecheck` / `build` | static checks (typecheck includes test files) |
| `test` | unit tests, no services needed |
| `test:integration` | tests against real Postgres and Redis (needs the Quick start steps above) |
| `db:generate` | generate a SQL migration from schema changes |
| `db:migrate` | apply migrations |
| `db:seed` | upsert permissions |

## Repository layout

```
apps/api/src
  config.ts            Zod-validated environment, fails fast at boot
  app.ts, server.ts    Express wiring, graceful shutdown
  http/middleware/     requestId, httpLogger, validate, notFound, errorHandler
  http/routes/         health (liveness and readiness)
  db/                  Drizzle schema, seed, per-org role provisioning
  infra/               Postgres pool, Redis client
  types/errors.ts      AppError hierarchy (standard error codes)
apps/api/drizzle/      generated SQL migrations (committed)
docs/adr/              architecture decision records
docs/architecture/     Mermaid diagrams (implemented vs planned)
```

## Documentation

Decisions and the reasoning behind them:

- [ADR-001 Data access with Drizzle](docs/adr/001-data-access-drizzle.md)
- [ADR-002 Identity schema and RBAC](docs/adr/002-identity-schema-and-rbac.md)
- [ADR-003 Config and error handling](docs/adr/003-config-and-error-handling.md)
- [ADR-004 Observability and request pipeline](docs/adr/004-observability-and-request-pipeline.md)
- [ADR-005 Testing strategy and CI](docs/adr/005-testing-strategy-and-ci.md)
- [Architecture diagrams](docs/architecture/)

## API conventions

Every response uses one envelope. Errors:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "details": [] } }
```

Every response carries an `X-Request-Id` header that also appears on every log line for that request.

## CI

Three parallel jobs on every push and PR to `main` and `develop`: quality (lint, typecheck, build), unit tests, and integration tests with Postgres + Redis service containers, including a migration drift check.
