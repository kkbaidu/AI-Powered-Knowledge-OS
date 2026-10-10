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

describe("GET /api/v1/health", () => {
  it("returns 200 when postgres and redis are both reachable", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis() });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      checks: { postgres: true, redis: true },
    });
  });

  it("returns 503 and flags redis specifically when redis is down", async () => {
    const brokenRedis = fakeRedis({
      ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const app = createApp({ pgPool: fakePool(), redis: brokenRedis });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      checks: { postgres: true, redis: false },
    });
  });

  it("returns 503 when postgres is down, independent of redis", async () => {
    const brokenPool = fakePool({
      query: vi.fn().mockRejectedValue(new Error("connection terminated")),
    });
    const app = createApp({ pgPool: brokenPool, redis: fakeRedis() });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ postgres: false, redis: true });
  });

  it("returns the standard 404 shape for an unknown route", async () => {
    const app = createApp({ pgPool: fakePool(), redis: fakeRedis() });

    const res = await request(app).get("/api/v1/nonsense");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Route GET /api/v1/nonsense not found" },
    });
  });
});