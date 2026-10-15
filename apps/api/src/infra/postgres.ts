import { Pool } from "pg";
import type { Config } from "../config.js";
import { drizzle } from 'drizzle-orm/node-postgres';

export function createPostgresPool(cfg: Config["postgres"]): Pool {
  return new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// You can specify any property from the node-postgres connection options
const db = drizzle({ 
  connection: { 
    connectionString: process.env.DATABASE_URL!,
    ssl: true
  }
});