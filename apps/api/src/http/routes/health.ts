import { Router } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

export interface HealthDeps {
  pgPool: Pool;
  redis: Redis;
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const checks = { postgres: false, redis: false };

    try {
      await deps.pgPool.query("SELECT 1");
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }

    try {
      await deps.redis.ping();
      checks.redis = true;
    } catch {
      checks.redis = false;
    }

    const healthy = checks.postgres && checks.redis;
    res.status(healthy ? 200 : 503).json({ success: healthy, checks });
  });

  return router;
}