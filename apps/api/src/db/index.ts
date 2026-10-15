import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema"

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                       // cap concurrent connections
  idleTimeoutMillis: 30_000,     // release idle connections
  connectionTimeoutMillis: 5_000 // fail fast if DB is unreachable
});

// An idle client erroring (e.g. DB restart) would otherwise crash the process
pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error", err);
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;