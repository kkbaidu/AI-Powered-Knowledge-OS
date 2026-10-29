import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { createRedisClient } from "./redis.js";
import { createRedisRateLimiter } from "./rateLimiter.js";
import { unique } from "../test/integration.js";

// Real Redis, because the point is the Lua script: atomicity, TIME, expiry.
const redis: Redis = createRedisClient(config.redis);
const PREFIX = `rl-test-${unique("run")}:`;
const limiter = createRedisRateLimiter(redis, { prefix: PREFIX });
const key = () => unique("key");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    await redis.ping();
  } catch (err) {
    throw new Error(
      "Integration tests need a running Redis. Run: docker compose up -d redis\n" +
        `Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
});

afterAll(async () => {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

describe("createRedisRateLimiter", () => {
  it("allows up to the limit, counting down, then blocks", async () => {
    const k = key();
    const rule = { limit: 3, windowSeconds: 30 };

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.consume(k, rule));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[3]!.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(results[3]!.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("is atomic: 60 parallel requests against a limit of 10 let exactly 10 through", async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => limiter.consume(k, { limit: 10, windowSeconds: 30 })),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it("slides: capacity returns as old requests leave the window, with no boundary burst", async () => {
    const k = key();
    const rule = { limit: 2, windowSeconds: 1 };

    expect((await limiter.consume(k, rule)).allowed).toBe(true); // t=0
    await sleep(600);
    expect((await limiter.consume(k, rule)).allowed).toBe(true); // t=0.6
    expect((await limiter.consume(k, rule)).allowed).toBe(false); // full

    await sleep(500); // t=1.1: the first request left the window, the second has not
    expect((await limiter.consume(k, rule)).allowed).toBe(true);
    expect((await limiter.consume(k, rule)).allowed).toBe(false);
  });

  it("allows everything again after the whole window passes", async () => {
    const k = key();
    const rule = { limit: 1, windowSeconds: 1 };
    await limiter.consume(k, rule);
    expect((await limiter.consume(k, rule)).allowed).toBe(false);

    await sleep(1100);
    expect((await limiter.consume(k, rule)).allowed).toBe(true);
  });

  it("keeps keys independent", async () => {
    const rule = { limit: 1, windowSeconds: 30 };
    const a = key();
    const b = key();
    await limiter.consume(a, rule);

    expect((await limiter.consume(a, rule)).allowed).toBe(false);
    expect((await limiter.consume(b, rule)).allowed).toBe(true);
  });

  it("does not count blocked requests, so hammering cannot extend the lockout", async () => {
    const k = key();
    const rule = { limit: 1, windowSeconds: 2 };
    await limiter.consume(k, rule);
    const first = await limiter.consume(k, rule);
    for (let i = 0; i < 20; i++) await limiter.consume(k, rule);
    const last = await limiter.consume(k, rule);

    expect(last.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
    expect(await redis.zcard(PREFIX + k)).toBe(1);
  });

  it("sets a TTL on the key so idle counters clean themselves up", async () => {
    const k = key();
    await limiter.consume(k, { limit: 5, windowSeconds: 30 });

    const ttl = await redis.pttl(PREFIX + k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it("reset clears the counter", async () => {
    const k = key();
    const rule = { limit: 1, windowSeconds: 30 };
    await limiter.consume(k, rule);
    expect((await limiter.consume(k, rule)).allowed).toBe(false);

    await limiter.reset(k);
    expect((await limiter.consume(k, rule)).allowed).toBe(true);
  });

  it("namespaces keys with the prefix", async () => {
    const k = key();
    await limiter.consume(k, { limit: 1, windowSeconds: 30 });
    expect(await redis.exists(PREFIX + k)).toBe(1);
    expect(await redis.exists(k)).toBe(0);
  });
});
