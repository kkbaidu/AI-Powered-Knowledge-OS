import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import { config } from "../config.js";
import { createApp } from "../app.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createDb } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";
import { assertDatabaseReady, unique } from "../test/integration.js";
import { testAuthConfig } from "../test/auth.js";
import { noopRateLimiter } from "../test/rateLimiter.js";
import { hash } from "@node-rs/argon2";
import { ARGON2_POLICY, hashPassword } from "./passwords.js";
import { hashRefreshToken } from "./tokens.js";
import { verifyAccessToken } from "./accessTokens.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
const redis = { ping: async () => "PONG", on: () => undefined } as unknown as Redis;
const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: pool, redis });
const productionApp = createApp({
  rateLimiter: noopRateLimiter,
  auth: { ...testAuthConfig, secureCookies: true },
  pgPool: pool,
  redis,
});

const PASSWORD = "correct-horse-battery";
const createdUserIds: string[] = [];

async function makeUser(
  overrides: Partial<typeof users.$inferInsert> = {},
  password = PASSWORD,
) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${unique("login")}@example.com`,
      passwordHash: await hashPassword(password),
      status: "active",
      ...overrides,
    })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

const login = (body: unknown, target = app) =>
  request(target).post("/api/v1/auth/login").send(body as object);

// "refresh_token=abc; Path=/api/v1/auth; ..." -> the cookie header line
function refreshCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith("refresh_token="));
  if (!line) throw new Error("no refresh_token cookie was set");
  return line;
}
const cookieValue = (line: string) => line.split(";")[0]!.slice("refresh_token=".length);

beforeAll(() => assertDatabaseReady(pool));
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds)); // sessions cascade
  }
  await pool.end();
});

describe("POST /api/v1/auth/login: success", () => {
  it("returns the user and a verifiable access token, with no password material", async () => {
    const user = await makeUser();
    const res = await login({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, email: user.email });
    expect(res.body.data.expiresIn).toBe(900);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|password_hash/i);

    const claims = await verifyAccessToken(res.body.data.accessToken, testAuthConfig);
    expect(claims.userId).toBe(user.id);
  });

  it("creates a session whose stored hash matches the cookie, never the raw token", async () => {
    const user = await makeUser();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("User-Agent", "AtlasTest/1.0")
      .send({ email: user.email, password: PASSWORD });

    const token = cookieValue(refreshCookie(res));
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));

    expect(rows).toHaveLength(1);
    const session = rows[0]!;
    expect(session.refreshTokenHash).toBe(hashRefreshToken(token));
    expect(session.refreshTokenHash).not.toBe(token);
    expect(session.previousTokenHash).toBeNull();
    expect(session.revoked).toBe(false);
    expect(session.deviceInfo).toBe("AtlasTest/1.0");
    expect(session.ipAddress).toBeTruthy();
    // refresh TTL is 30 days from now
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);
    // the access token points at this session
    expect((await verifyAccessToken(res.body.data.accessToken, testAuthConfig)).sessionId).toBe(
      session.id,
    );
  });

  it("never returns the refresh token in the body", async () => {
    const user = await makeUser();
    const res = await login({ email: user.email, password: PASSWORD });
    const token = cookieValue(refreshCookie(res));
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("sets a hardened refresh cookie scoped to the auth routes", async () => {
    const user = await makeUser();
    const line = refreshCookie(await login({ email: user.email, password: PASSWORD }));

    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Path=/api/v1/auth");
    expect(line).toContain("Max-Age=2592000");
    expect(line).not.toContain("Secure"); // plain http outside production
    expect(cookieValue(line)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("adds Secure to the cookie when running in production mode", async () => {
    const user = await makeUser();
    const res = await login({ email: user.email, password: PASSWORD }, productionApp);
    expect(refreshCookie(res)).toContain("Secure");
  });

  it("forbids caching of the response", async () => {
    const user = await makeUser();
    const res = await login({ email: user.email, password: PASSWORD });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("accepts the email in any case and with surrounding spaces", async () => {
    const user = await makeUser();
    const res = await login({ email: `  ${user.email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("gives every login its own session and token (multiple devices)", async () => {
    const user = await makeUser();
    const a = await login({ email: user.email, password: PASSWORD });
    const b = await login({ email: user.email, password: PASSWORD });

    expect(cookieValue(refreshCookie(a))).not.toBe(cookieValue(refreshCookie(b)));
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(2);
  });
});

describe("POST /api/v1/auth/login: failures", () => {
  it("returns an identical 401 for a wrong password and for an unknown email", async () => {
    const user = await makeUser();
    const wrongPassword = await login({ email: user.email, password: "not-the-password" });
    const unknownEmail = await login({ email: "nobody@example.com", password: "not-the-password" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error).toEqual(unknownEmail.body.error);
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
  });

  it("creates no session on a failed login", async () => {
    const user = await makeUser();
    await login({ email: user.email, password: "wrong-password-here" });
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("treats an account with no password (OAuth-only) as invalid credentials", async () => {
    const user = await makeUser({ passwordHash: null });
    const res = await login({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("blocks a suspended user, but only after the password is correct", async () => {
    const user = await makeUser({ status: "suspended" });

    const ok = await login({ email: user.email, password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(ok.headers["set-cookie"]).toBeUndefined();

    const bad = await login({ email: user.email, password: "wrong-password-here" });
    expect(bad.status).toBe(401); // status is not leaked to someone without the password
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("blocks a user who has not verified their email", async () => {
    const user = await makeUser({ status: "pending_verification" });
    const res = await login({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("returns 422 for a malformed body and does not reveal anything about accounts", async () => {
    const res = await login({ email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/v1/auth/login: password rehash", () => {
  it("upgrades a hash made with weaker parameters after a successful login", async () => {
    const weak = await hash(PASSWORD, { ...ARGON2_POLICY, memoryCost: 8192, timeCost: 1 });
    const user = await makeUser({ passwordHash: weak });

    expect((await login({ email: user.email, password: PASSWORD })).status).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.passwordHash).not.toBe(weak);
    expect(row!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    // and the new hash still works
    expect((await login({ email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it("leaves a current hash untouched", async () => {
    const user = await makeUser();
    await login({ email: user.email, password: PASSWORD });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.passwordHash).toBe(user.passwordHash);
  });

  it("does not rehash when the password was wrong", async () => {
    const weak = await hash(PASSWORD, { ...ARGON2_POLICY, memoryCost: 8192, timeCost: 1 });
    const user = await makeUser({ passwordHash: weak });
    await login({ email: user.email, password: "wrong-password-here" });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.passwordHash).toBe(weak);
  });
});
