import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { createApp } from "./app.js";

function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    on: vi.fn(),
    ...overrides,
  } as unknown as Pool;
}

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    ping: vi.fn().mockResolvedValue("PONG"),
    on: vi.fn(),
    ...overrides,
  } as unknown as Redis;
}

describe("GET /api/v1/health/ready", () => {
  it("returns 200 when postgres and redis are both reachable", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis() });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      status: "ready",
      checks: { postgres: true, redis: true },
    });
  });

  it("returns 503 and flags redis specifically when redis is down", async () => {
    const brokenRedis = fakeRedis({
      ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const app = createApp({ pgPool: fakePool(), redis: brokenRedis });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      status: "degraded",
      checks: { postgres: true, redis: false },
    });
  });

  it("returns 503 when postgres is down, independent of redis", async () => {
    const brokenPool = fakePool({
      query: vi.fn().mockRejectedValue(new Error("connection terminated")),
    });
    const app = createApp({ pgPool: brokenPool, redis: fakeRedis() });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: false, redis: true });
  });

  it("returns the standard 404 shape for an unknown route", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis() });

    const res = await request(app).get("/api/v1/nonsense");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: "ROUTE_NOT_FOUND", message: "Route GET /api/v1/nonsense not found" },
    });
  });
});
describe("health liveness and readiness", () => {
  it("liveness stays 200 even when every dependency is down", async () => {
    const app = createApp({
      pgPool: fakePool({ query: vi.fn().mockRejectedValue(new Error("down")) }),
      redis: fakeRedis({ ping: vi.fn().mockRejectedValue(new Error("down")) }),
    });

    const res = await request(app).get("/api/v1/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: "alive" });
  });

  it("liveness never touches dependencies", async () => {
    const pool = fakePool();
    const redis = fakeRedis();
    const app = createApp({ pgPool: pool, redis });

    await request(app).get("/api/v1/health/live");

    expect(pool.query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it("readiness reports 503 when a dependency hangs, instead of hanging itself", async () => {
    const hangingRedis = fakeRedis({ ping: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    const app = createApp({ pgPool: fakePool(), redis: hangingRedis, checkTimeoutMs: 50 });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: true, redis: false });
  });

  it("readiness returns 503 shutting_down once shutdown has started", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis(), isShuttingDown: () => true });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, status: "shutting_down" });
  });

  it("keeps /health as an alias of readiness", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis() });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });
});
