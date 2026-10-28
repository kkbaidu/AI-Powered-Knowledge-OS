import { defineConfig } from "vitest/config";

// Unit tests only: fast, no external services. Integration tests (real Postgres
// and Redis) live in *.integration.test.ts and run via vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
