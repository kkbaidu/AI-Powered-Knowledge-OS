import { Pool } from "pg";
import type { Config } from "../config.js";
import { logger } from "../logger.js";

export function createPostgresPool(cfg: Config["postgres"]): Pool {
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle client erroring (e.g. the database restarts) emits "error" on the
  // pool; with no listener, Node treats it as an uncaught exception and crashes.
  pool.on("error", (err) => {
    logger.error(err, "Unexpected Postgres pool error");
  });

  return pool;
}