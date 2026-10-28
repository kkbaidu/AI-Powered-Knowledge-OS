import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

export interface HealthDeps {
  pgPool: Pool;
  redis: Redis;
  // Flipped to true when shutdown starts, so readiness fails and the load
  // balancer stops sending traffic before the process exits.
  isShuttingDown?: () => boolean;
  // Per-dependency probe timeout; overridable so tests do not wait 2 seconds.
  checkTimeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

// A hung dependency must not hang the probe: the orchestrator would time out and
// learn nothing. Resolve false on error or timeout.
async function check(probe: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();
  const timeoutMs = deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  // Liveness: "is this process running and able to answer?" No dependency checks.
  // If this fails, the orchestrator restarts the container. Checking Postgres here
  // would make a DB outage restart every healthy API instance, making things worse.
  router.get("/health/live", (_req, res) => {
    res.status(200).json({ success: true, status: "alive" });
  });

  // Readiness: "should this instance receive traffic right now?" Checks dependencies.
  // If this fails, the instance is taken out of rotation but NOT restarted.
  const readiness = async (_req: Request, res: Response) => {
    if (deps.isShuttingDown?.()) {
      res.status(503).json({ success: false, status: "shutting_down" });
      return;
    }

    const [postgres, redis] = await Promise.all([
      check(() => deps.pgPool.query("SELECT 1"), timeoutMs),
      check(() => deps.redis.ping(), timeoutMs),
    ]);

    const ready = postgres && redis;
    res.status(ready ? 200 : 503).json({
      success: ready,
      status: ready ? "ready" : "degraded",
      checks: { postgres, redis },
    });
  };

  router.get("/health/ready", readiness);
  // Backward-compatible alias.
  router.get("/health", readiness);

  return router;
}
