import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { AUTH_BODY_LIMIT, createApp } from "./app.js";
import { testAuthConfig } from "./test/auth.js";
import { noopRateLimiter } from "./test/rateLimiter.js";

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
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: fakeRedis() });

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
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: brokenRedis });

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
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: brokenPool, redis: fakeRedis() });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: false, redis: true });
  });

  it("returns the standard 404 shape for an unknown route", async () => {
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: fakeRedis() });

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
      auth: testAuthConfig, rateLimiter: noopRateLimiter,
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
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: pool, redis });

    await request(app).get("/api/v1/health/live");

    expect(pool.query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it("readiness reports 503 when a dependency hangs, instead of hanging itself", async () => {
    const hangingRedis = fakeRedis({ ping: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: hangingRedis, checkTimeoutMs: 50 });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: true, redis: false });
  });

  it("readiness returns 503 shutting_down once shutdown has started", async () => {
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: fakeRedis(), isShuttingDown: () => true });

    const res = await request(app).get("/api/v1/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, status: "shutting_down" });
  });

  it("keeps /health as an alias of readiness", async () => {
    const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: fakeRedis() });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });
});


describe("request body limits", () => {
  const app = () =>
    createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: fakePool(), redis: fakeRedis() });

  it("rejects an oversized body on the unauthenticated auth routes with 413", async () => {
    const body = { email: "a@example.com", password: "x", padding: "a".repeat(5000) };
    for (const path of ["/api/v1/auth/login", "/api/v1/auth/register"]) {
      const res = await request(app()).post(path).send(body);
      expect(res.status, path).toBe(413);
      expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("accepts a body just under the cap (it reaches validation instead)", async () => {
    const res = await request(app())
      .post("/api/v1/auth/login")
      .send({ email: "nope", padding: "a".repeat(3000) });
    expect(res.status).toBe(422);
  });

  it("keeps the cap well above the largest legitimate auth request", () => {
    // Worst case: every field at its maximum and every character JSON-escaped to \uXXXX.
    const worst = JSON.stringify({
      email: `${"a".repeat(242)}@example.com`,
      password: "\u0001".repeat(128),
      displayName: "\u0001".repeat(100),
    });
    const limitBytes = Number.parseInt(AUTH_BODY_LIMIT, 10) * 1024;
    expect(Buffer.byteLength(worst)).toBeLessThan(limitBytes / 2);
  });

  it("does not apply the small cap to other routes", async () => {
    const res = await request(app())
      .post("/api/v1/does-not-exist")
      .send({ padding: "a".repeat(100_000) });
    expect(res.status).toBe(404); // parsed fine, then not found; not 413
  });
});
