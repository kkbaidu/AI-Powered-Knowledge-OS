import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

// The pool is created in infra/postgres.ts and shared with the health check.
// Drizzle just wraps it, so there is one connection pool per process.
export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
// Accepts either the db or an open transaction, so callers can compose.
export type DbExecutor = Database | Transaction;
