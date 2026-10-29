import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Redis } from "ioredis";
import { eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { createApp } from "../app.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createRedisClient } from "../infra/redis.js";
import { createRedisRateLimiter } from "../infra/rateLimiter.js";
import { createDb } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";
import { assertDatabaseReady, unique } from "../test/integration.js";
import { testAuthConfig } from "../test/auth.js";
import { hashPassword } from "./passwords.js";
import type { AuthRateLimits } from "./rateLimitPolicy.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
const redis = createRedisClient(config.redis);
const PREFIX = `rl-http-${unique("run")}:`;

// Tiny limits so the tests stay fast. Same shapes as the production defaults.
const limits: AuthRateLimits = {
  register: { limit: 3, windowSeconds: 60 },
  loginPerIp: { limit: 6, windowSeconds: 60 },
  loginPerIpAndEmail: { limit: 3, windowSeconds: 60 },
};

const base = { auth: testAuthConfig, pgPool: pool, redis, rateLimits: limits };
// One trusted proxy hop: tests choose the client address through X-Forwarded-For.
const app = createApp({ ...base, rateLimiter: createRedisRateLimiter(redis, { prefix: PREFIX }), trustProxyHops: 1 });
// No trusted proxy: X-Forwarded-For must be ignored.
const untrustedApp = createApp({ ...base, rateLimiter: createRedisRateLimiter(redis, { prefix: `${PREFIX}u:` }), trustProxyHops: 0 });

const PASSWORD = "correct-horse-battery";
const createdUserIds: string[] = [];
const createdEmails: string[] = [];

const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function makeUser() {
  const [user] = await db
    .insert(users)
    .values({ email: `${unique("rl")}@example.com`, passwordHash: await hashPassword(PASSWORD), status: "active" })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

const login = (email: string, password: string, ip: string, target = app) =>
  request(target).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({ email, password });
const register = (email: string, ip: string) =>
  request(app).post("/api/v1/auth/register").set("X-Forwarded-For", ip).send({ email, password: PASSWORD });

beforeAll(async () => {
  await assertDatabaseReady(pool);
  await redis.ping();
});
afterAll(async () => {
  if (createdEmails.length > 0) await db.delete(users).where(inArray(users.email, createdEmails));
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  await pool.end();
  redis.disconnect();
});

describe("login throttling", () => {
  it("blocks guessing at one account from one address, even when the next guess is correct", async () => {
    const user = await makeUser();
    const ip = randomIp();

    for (let i = 0; i < 3; i++) {
      expect((await login(user.email, "wrong-password-xx", ip)).status).toBe(401);
    }
    const blocked = await login(user.email, PASSWORD, ip); // the right password

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(blocked.headers["set-cookie"]).toBeUndefined();
    // a throttled request never reached the credential check, so no session exists
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("does not let a stranger lock the real owner out: the budget is per address AND email", async () => {
    const user = await makeUser();
    const attacker = randomIp();
    const owner = randomIp();

    for (let i = 0; i < 4; i++) await login(user.email, "wrong-password-xx", attacker);
    expect((await login(user.email, "wrong-password-xx", attacker)).status).toBe(429);

    expect((await login(user.email, PASSWORD, owner)).status).toBe(200);
  });

  it("does not throttle other accounts from the same address on the per-account rule", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const ip = randomIp();

    for (let i = 0; i < 3; i++) await login(a.email, "wrong-password-xx", ip);
    expect((await login(a.email, "wrong-password-xx", ip)).status).toBe(429);

    expect((await login(b.email, PASSWORD, ip)).status).toBe(200);
  });

  it("clears the per-account budget after a successful login", async () => {
    const user = await makeUser();
    const ip = randomIp();

    await login(user.email, "wrong-password-xx", ip);
    await login(user.email, "wrong-password-xx", ip);
    expect((await login(user.email, PASSWORD, ip)).status).toBe(200);

    // two fresh failures would have been the 4th and 5th attempt without the reset
    for (let i = 0; i < 3; i++) {
      expect((await login(user.email, "wrong-password-xx", ip)).status).toBe(401);
    }
    expect((await login(user.email, "wrong-password-xx", ip)).status).toBe(429);
  });

  it("caps one address spraying many emails, and a successful login does not refund that budget", async () => {
    const owned = await makeUser();
    const ip = randomIp();

    // 6 attempts against 6 different emails, one of them a real login
    expect((await login(owned.email, PASSWORD, ip)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await login(`${unique("nobody")}@example.com`, "wrong-password-xx", ip)).status).toBe(401);
    }

    const res = await login(`${unique("nobody")}@example.com`, "wrong-password-xx", ip);
    expect(res.status).toBe(429);
  });

  it("lets exactly the allowed number of parallel guesses through", async () => {
    const user = await makeUser();
    const ip = randomIp();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => login(user.email, "wrong-password-xx", ip)),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(9);
  });

  it("cannot be bypassed by sending a different X-Forwarded-For when no proxy is trusted", async () => {
    const user = await makeUser();

    for (let i = 0; i < 3; i++) await login(user.email, "wrong-password-xx", randomIp(), untrustedApp);
    const res = await login(user.email, "wrong-password-xx", randomIp(), untrustedApp);

    expect(res.status).toBe(429);
  });

  it("does not count requests that fail validation", async () => {
    const user = await makeUser();
    const ip = randomIp();

    for (let i = 0; i < 10; i++) {
      const bad = await request(app).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({ email: "nope" });
      expect(bad.status).toBe(422);
    }
    expect((await login(user.email, PASSWORD, ip)).status).toBe(200);
  });

  it("treats email case and spacing as the same account when counting", async () => {
    const user = await makeUser();
    const ip = randomIp();

    await login(user.email, "wrong-password-xx", ip);
    await login(user.email.toUpperCase(), "wrong-password-xx", ip);
    await login(`  ${user.email} `, "wrong-password-xx", ip);

    expect((await login(user.email, PASSWORD, ip)).status).toBe(429);
  });
});

describe("register throttling", () => {
  it("blocks the request before any account is created", async () => {
    const ip = randomIp();
    const emails = Array.from({ length: 4 }, () => `${unique("reg")}@example.com`);
    createdEmails.push(...emails);

    for (const email of emails.slice(0, 3)) expect((await register(email, ip)).status).toBe(201);
    const blocked = await register(emails[3]!, ip);

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(await db.select().from(users).where(eq(users.email, emails[3]!))).toHaveLength(0);
  });

  it("gives other addresses their own budget", async () => {
    const first = randomIp();
    const second = randomIp();
    const emails = Array.from({ length: 4 }, () => `${unique("reg")}@example.com`);
    createdEmails.push(...emails);

    for (const email of emails.slice(0, 3)) await register(email, first);
    expect((await register(emails[3]!, first)).status).toBe(429);
    expect((await register(emails[3]!, second)).status).toBe(201);
  });
});

describe("when Redis is unavailable", () => {
  it("fails open: login still works, and is not throttled", async () => {
    const deadRedis = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    const brokenApp = createApp({
      ...base,
      rateLimiter: createRedisRateLimiter(deadRedis, { prefix: PREFIX }),
      trustProxyHops: 1,
    });
    const user = await makeUser();
    const ip = randomIp();

    for (let i = 0; i < 6; i++) {
      expect((await login(user.email, "wrong-password-xx", ip, brokenApp)).status).toBe(401);
    }
    expect((await login(user.email, PASSWORD, ip, brokenApp)).status).toBe(200);
    deadRedis.disconnect();
  });
});
