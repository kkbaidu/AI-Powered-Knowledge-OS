import { defineConfig } from "vitest/config";

// Unit AND integration tests in one run, so the report shows what the whole suite covers.
// Needs the same services as the integration config (Postgres with pgvector, Redis).
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/server.ts"],
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
    },
  },
});
