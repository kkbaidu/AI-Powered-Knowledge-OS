import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { createPostgresPool } from "./infra/postgres.js";
import { createRedisClient } from "./infra/redis.js";

const pool = createPostgresPool(config.postgres);
const redis = createRedisClient(config.redis);

// Deliberately unreachable dependencies (port 1 refuses connections).
const deadPool = createPostgresPool({ ...config.postgres, port: 1 });
const deadRedis = new Redis({
  host: "127.0.0.1",
  port: 1,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null,
  maxRetriesPerRequest: 0,
});

afterAll(async () => {
  await pool.end();
  await deadPool.end();
  redis.disconnect();
  deadRedis.disconnect();
});

describe("health against real Postgres and Redis", () => {
  it("readiness is 200 when both dependencies are reachable", async () => {
    const res = await request(createApp({ pgPool: pool, redis })).get("/api/v1/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      status: "ready",
      checks: { postgres: true, redis: true },
    });
  });

  it("readiness is 503 and names postgres when Postgres is unreachable", async () => {
    const app = createApp({ pgPool: deadPool, redis, checkTimeoutMs: 1_500 });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: false, redis: true });
  });

  it("readiness is 503 and names redis when Redis is unreachable", async () => {
    const app = createApp({ pgPool: pool, redis: deadRedis, checkTimeoutMs: 1_500 });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: true, redis: false });
  });

  it("liveness stays 200 even when both dependencies are unreachable", async () => {
    const app = createApp({ pgPool: deadPool, redis: deadRedis });

    const res = await request(app).get("/api/v1/health/live");

    expect(res.status).toBe(200);
  });

  it("returns the standard error shape and a request ID for unknown routes", async () => {
    const res = await request(createApp({ pgPool: pool, redis })).get("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
