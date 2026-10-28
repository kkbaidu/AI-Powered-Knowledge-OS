import { defineConfig } from "vitest/config";

// Requires running Postgres (with pgvector) and Redis, and a migrated database:
//   docker compose up -d postgres redis && pnpm --filter @atlas/api db:migrate
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.integration.test.ts"],
    // Files share one database, so run them one at a time for determinism.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
