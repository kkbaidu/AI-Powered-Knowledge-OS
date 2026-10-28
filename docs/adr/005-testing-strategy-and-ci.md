# ADR-005: Testing strategy and CI pipeline

Status: Accepted · Date: 2026-10-28

## Context
CI ran one job (lint, build, unit tests with fakes). It could not tell us whether the
migrations apply, whether constraints and cascades behave, whether the seed is idempotent,
or whether readiness works against real Postgres and Redis, which are exactly the things
that break in production. Test files were also never type-checked (excluded from the
build, and Vitest does not type-check).

## Decisions

| Layer | Runs | Needs | Proves |
|---|---|---|---|
| Unit (`*.test.ts`) | `pnpm test` | nothing | logic, error shapes, config parsing, seed-data invariants |
| Integration (`*.integration.test.ts`) | `pnpm test:integration` | Postgres+pgvector, Redis, migrated DB | schema, constraints, cascades, seed and provisioning idempotency, real readiness |
| Typecheck | `pnpm typecheck` | nothing | source **and** tests compile (`tsconfig.test.json`) |

CI jobs run in parallel so feedback is fast and a failure points at the cause:
1. **quality**: lint, typecheck (incl. tests), build, `docker compose config`.
2. **unit**: unit tests only (no services, cannot flake on infrastructure).
3. **integration**: service containers (`pgvector/pgvector:pg16`, `redis:7-alpine`), then
   migrate from empty, seed twice, **schema-drift check**, integration tests.

Schema-drift check: after migrating, `drizzle-kit generate` must produce no file. If someone
edits the Drizzle schema but forgets to commit a migration, the tree is dirty and CI fails.

Other choices:
- Integration tests create uniquely named rows and clean up, so they never depend on
  (or damage) other data; files run serially (`fileParallelism: false`).
- If the database is unreachable or unmigrated, the suite fails with an actionable
  message instead of a confusing SQL error.
- Verified by mutation: dropping the `lower(email)` index or changing the owner FK to
  CASCADE makes the integration suite fail.
- CI triggers on `main` and `develop` (pushes and PRs), `concurrency` cancels superseded
  runs, `permissions: contents: read` (least privilege), and every job has a timeout.
- A composite action (`.github/actions/setup`) removes the triplicated setup steps.

## Run locally
```
docker compose up -d postgres redis
pnpm --filter @atlas/api db:migrate
pnpm --filter @atlas/api test:integration
```

## Not covered yet (deliberately)
- Enforcement: CI only advises until branch protection requires these checks.
- Auth flows and RBAC enforcement: add integration/e2e tests with the Day 3 endpoints.
- Coverage thresholds, dependency audit/Dependabot, secret scanning, container image build.

## Interview notes
- *Why integration tests against real Postgres instead of mocking the DB?* Constraints,
  cascades, indexes and migrations are behavior of the database; a mock only echoes our assumptions.
- *Test pyramid?* Many fast unit tests, fewer integration tests on real dependencies, very few e2e.
- *Why a drift check?* It turns "forgot to generate a migration" from a production incident into a red build.
- *Why separate jobs?* Parallelism, clearer failures, and unit tests stay independent of infrastructure.
