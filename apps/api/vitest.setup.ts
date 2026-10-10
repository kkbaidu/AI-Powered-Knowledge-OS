// apps/api/vitest.setup.ts
try {
  process.loadEnvFile("../../.env");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    throw err;
  }
  // No .env file present (e.g. CI, where variables are injected directly
  // via the workflow's env: block) — nothing to load, carry on.
}