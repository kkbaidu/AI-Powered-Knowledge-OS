import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app, so it cannot import src/config.ts.
// Load the monorepo-root .env the same way vitest.setup.ts does, and
// tolerate its absence (CI injects variables directly).
try {
  process.loadEnvFile("../../.env");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to run drizzle-kit`);
  return value;
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(required("POSTGRES_PORT")),
    user: required("POSTGRES_USER"),
    password: required("POSTGRES_PASSWORD"),
    database: required("POSTGRES_DB"),
    ssl: false,
  },
  strict: true,
  verbose: true,
});
