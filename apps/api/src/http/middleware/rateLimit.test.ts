import { describe, it, expect, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import type { RateLimiter } from "../../infra/rateLimiter.js";
import { createMemoryRateLimiter } from "../../test/rateLimiter.js";
import { errorHandler } from "./errorHandler.js";
import { clientIp, rateLimit, resetRateLimit, type RateLimitRuleSpec } from "./rateLimit.js";

const perIp = (req: Request) => clientIp(req);

const rule = (over: Partial<RateLimitRuleSpec> = {}): RateLimitRuleSpec => ({
  name: "test",
  limit: 3,
  windowSeconds: 60,
  key: perIp,
  ...over,
});

function makeApp(
  limiter: RateLimiter,
  rules: RateLimitRuleSpec[],
  opts: { trustProxy?: number } = {},
) {
  const app = express();
  app.set("trust proxy", opts.trustProxy ?? false);
  app.get("/limited", rateLimit(limiter, rules), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("rateLimit", () => {
  it("allows requests up to the limit and then answers 429 with Retry-After", async () => {
    const app = makeApp(createMemoryRateLimiter(), [rule()]);

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/limited")).status).toBe(200);
    }
    const res = await request(app).get("/limited");

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res.headers["retry-after"]).toBe(String(res.body.error.details.retryAfterSeconds));
    expect(res.body.success).toBe(false);
  });

  it("recovers once the window has passed", async () => {
    let now = 1_000_000;
    const app = makeApp(createMemoryRateLimiter(() => now), [rule({ limit: 1, windowSeconds: 10 })]);

    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(429);

    now += 10_001;
    expect((await request(app).get("/limited")).status).toBe(200);
  });

  it("reports how long until the oldest request leaves the window", async () => {
    let now = 5_000_000;
    const app = makeApp(createMemoryRateLimiter(() => now), [rule({ limit: 1, windowSeconds: 60 })]);

    await request(app).get("/limited");
    now += 20_000;
    const res = await request(app).get("/limited");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("40");
  });

  it("evaluates rules in order and stops at the first that blocks", async () => {
    const limiter = createMemoryRateLimiter();
    const consume = vi.spyOn(limiter, "consume");
    const app = makeApp(limiter, [
      rule({ name: "strict", limit: 1 }),
      rule({ name: "loose", limit: 100 }),
    ]);

    await request(app).get("/limited"); // consumes strict and loose
    consume.mockClear();
    const res = await request(app).get("/limited"); // strict blocks: loose is not consulted

    expect(res.status).toBe(429);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("keeps separate rules and separate keys in separate buckets", async () => {
    const limiter = createMemoryRateLimiter();
    const a = makeApp(limiter, [rule({ name: "a", limit: 1 })]);
    const b = makeApp(limiter, [rule({ name: "b", limit: 1 })]);

    expect((await request(a).get("/limited")).status).toBe(200);
    expect((await request(a).get("/limited")).status).toBe(429);
    expect((await request(b).get("/limited")).status).toBe(200); // different rule name
  });

  it("fails OPEN when the limiter throws: the request goes through", async () => {
    const broken: RateLimiter = {
      consume: vi.fn().mockRejectedValue(new Error("redis down")),
      reset: vi.fn(),
    };
    const app = makeApp(broken, [rule()]);

    const res = await request(app).get("/limited");

    expect(res.status).toBe(200);
    expect(broken.consume).toHaveBeenCalled();
  });

  it("still enforces the remaining rules when one rule's lookup fails", async () => {
    const memory = createMemoryRateLimiter();
    const flaky: RateLimiter = {
      consume: async (key, r) => {
        if (key.startsWith("flaky:")) throw new Error("boom");
        return memory.consume(key, r);
      },
      reset: memory.reset,
    };
    const app = makeApp(flaky, [rule({ name: "flaky" }), rule({ name: "solid", limit: 1 })]);

    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(429);
  });
});

describe("clientIp and trust proxy", () => {
  const limitedByIp = (trustProxy: number) =>
    makeApp(createMemoryRateLimiter(), [rule({ limit: 1 })], { trustProxy });

  it("ignores X-Forwarded-For when no proxy is trusted, so it cannot be used to dodge the limit", async () => {
    const app = limitedByIp(0);

    expect((await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1")).status).toBe(200);
    // a different claimed address is still the same real client
    expect((await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2")).status).toBe(429);
  });

  it("uses X-Forwarded-For when the hop is trusted, giving each real client its own budget", async () => {
    const app = limitedByIp(1);

    expect((await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1")).status).toBe(200);
    expect((await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2")).status).toBe(200);
    expect((await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1")).status).toBe(429);
  });

  it("with one trusted hop, a spoofed leading entry does not help: only the last is believed", async () => {
    const app = limitedByIp(1);

    // the client prepends a fake address; our proxy appends the real one
    expect((await request(app).get("/limited").set("X-Forwarded-For", "9.9.9.9, 1.1.1.1")).status).toBe(200);
    expect((await request(app).get("/limited").set("X-Forwarded-For", "8.8.8.8, 1.1.1.1")).status).toBe(429);
  });

  it("maps an IPv4-mapped IPv6 address to the plain IPv4 form", () => {
    expect(clientIp({ ip: "::ffff:203.0.113.7" } as Request)).toBe("203.0.113.7");
    expect(clientIp({ ip: "203.0.113.7" } as Request)).toBe("203.0.113.7");
    expect(clientIp({ ip: "2001:db8::1" } as Request)).toBe("2001:db8::1");
    expect(clientIp({} as Request)).toBe("unknown");
  });
});

describe("resetRateLimit", () => {
  it("clears a rule's counter", async () => {
    const limiter = createMemoryRateLimiter();
    const spec = rule({ limit: 1 });
    const app = express();
    app.get("/limited", rateLimit(limiter, [spec]), (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/reset", async (req, res) => {
      await resetRateLimit(limiter, spec, req, res);
      res.json({ ok: true });
    });
    app.use(errorHandler);

    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(429);
    await request(app).get("/reset");
    expect((await request(app).get("/limited")).status).toBe(200);
  });

  it("swallows a failing reset instead of breaking the request", async () => {
    const limiter: RateLimiter = {
      consume: vi.fn(),
      reset: vi.fn().mockRejectedValue(new Error("redis down")),
    };
    const app = express();
    app.get("/reset", async (req, res) => {
      await resetRateLimit(limiter, rule(), req, res);
      res.json({ ok: true });
    });

    expect((await request(app).get("/reset")).status).toBe(200);
  });
});
