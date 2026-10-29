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
import { hashPassword } from "./passwords.js";
import { hashRefreshToken } from "./tokens.js";
import { verifyAccessToken } from "./accessTokens.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
const redis = { ping: async () => "PONG", on: () => undefined } as unknown as Redis;
const app = createApp({ auth: testAuthConfig, pgPool: pool, redis });
// Grace period off: any replay of a rotated token counts as theft immediately.
const strictApp = createApp({
  auth: { ...testAuthConfig, refreshReuseGraceSeconds: 0 },
  pgPool: pool,
  redis,
});

const PASSWORD = "correct-horse-battery";
const createdUserIds: string[] = [];

async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${unique("refresh")}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      status: "active",
      ...overrides,
    })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

function cookieLine(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith("refresh_token="));
}
const cookieValue = (line: string) => line.split(";")[0]!.slice("refresh_token=".length);

async function loginAs(email: string, target = app) {
  const res = await request(target).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const token = cookieValue(cookieLine(res)!);
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hashRefreshToken(token)));
  return { token, sessionId: session!.id, userId: session!.userId };
}

const refresh = (token: string | undefined, target = app) => {
  const req = request(target).post("/api/v1/auth/refresh");
  return token === undefined ? req : req.set("Cookie", `refresh_token=${token}`);
};

const getSession = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;

// Pretend the last rotation happened `seconds` ago, to step outside the grace window.
const ageSession = (id: string, seconds: number) =>
  db
    .update(sessions)
    .set({ lastUsedAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(sessions.id, id));

const isCleared = (res: request.Response) => {
  const line = cookieLine(res);
  return !!line && /Expires=Thu, 01 Jan 1970/.test(line) && cookieValue(line) === "";
};

beforeAll(() => assertDatabaseReady(pool));
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds)); // sessions cascade
  }
  await pool.end();
});

describe("POST /api/v1/auth/refresh: rotation", () => {
  it("issues a new token pair for the same session and moves the old hash to previous", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);
    const before = await getSession(sessionId);

    const res = await refresh(token);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.expiresIn).toBe(900);
    const claims = await verifyAccessToken(res.body.data.accessToken, testAuthConfig);
    expect(claims).toEqual({ userId: user.id, sessionId });

    const newToken = cookieValue(cookieLine(res)!);
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken).not.toBe(token);
    expect(JSON.stringify(res.body)).not.toContain(newToken);

    const after = await getSession(sessionId);
    expect(after.refreshTokenHash).toBe(hashRefreshToken(newToken));
    expect(after.previousTokenHash).toBe(hashRefreshToken(token));
    expect(after.revoked).toBe(false);
    expect(after.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before.lastUsedAt!.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
  });

  it("sets the same hardened cookie as login", async () => {
    const user = await makeUser();
    const { token } = await loginAs(user.email);
    const line = cookieLine(await refresh(token))!;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Path=/api/v1/auth");
    expect(line).toContain("Max-Age=2592000");
  });

  it("can be chained: each new token works once", async () => {
    const user = await makeUser();
    let { token } = await loginAs(user.email);
    for (let i = 0; i < 4; i++) {
      const res = await refresh(token);
      expect(res.status).toBe(200);
      token = cookieValue(cookieLine(res)!);
    }
  });

  it("keeps sessions of the same user independent", async () => {
    const user = await makeUser();
    const a = await loginAs(user.email);
    const b = await loginAs(user.email);

    expect((await refresh(a.token)).status).toBe(200);
    expect((await refresh(b.token)).status).toBe(200);
  });
});

describe("POST /api/v1/auth/refresh: reuse detection", () => {
  it("revokes the whole session when an old token is replayed after the grace period", async () => {
    const user = await makeUser();
    const { token: stolen, sessionId } = await loginAs(user.email);

    // the thief (or the user) rotates first ...
    const rotated = await refresh(stolen);
    const newToken = cookieValue(cookieLine(rotated)!);
    await ageSession(sessionId, 60);

    // ... then the other party presents the old token
    const replay = await refresh(stolen);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_REUSED");
    expect(isCleared(replay)).toBe(true);
    expect((await getSession(sessionId)).revoked).toBe(true);

    // the newest token, held by the other party, is dead too
    const second = await refresh(newToken);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("does not touch the user's other sessions", async () => {
    const user = await makeUser();
    const a = await loginAs(user.email);
    const b = await loginAs(user.email);

    await refresh(a.token);
    await ageSession(a.sessionId, 60);
    await refresh(a.token); // reuse -> revokes session A only

    expect((await getSession(a.sessionId)).revoked).toBe(true);
    expect((await getSession(b.sessionId)).revoked).toBe(false);
    expect((await refresh(b.token)).status).toBe(200);
  });

  it("inside the grace period a replay is rejected but the session survives", async () => {
    const user = await makeUser();
    const { token: old, sessionId } = await loginAs(user.email);
    const rotated = await refresh(old);
    const current = cookieValue(cookieLine(rotated)!);

    const replay = await refresh(old);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_ROTATED");
    expect(replay.body.data).toBeUndefined();
    expect((await getSession(sessionId)).revoked).toBe(false);

    // the legitimate holder of the new token carries on
    expect((await refresh(current)).status).toBe(200);
  });

  it("only remembers one previous token: older ones are rejected without a revoke", async () => {
    const user = await makeUser();
    const { token: t1, sessionId } = await loginAs(user.email);
    const t2 = cookieValue(cookieLine(await refresh(t1))!);
    await refresh(t2); // t1 is now two rotations old

    const res = await refresh(t1);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect((await getSession(sessionId)).revoked).toBe(false); // documented limitation
  });
});

describe("POST /api/v1/auth/refresh: concurrency", () => {
  it("lets exactly one of several simultaneous refreshes rotate, without revoking the session", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);

    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(token)));

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(5);
    for (const r of losers) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("REFRESH_TOKEN_ROTATED");
    }

    expect((await getSession(sessionId)).revoked).toBe(false);
    const winnerToken = cookieValue(cookieLine(winners[0]!)!);
    expect((await refresh(winnerToken)).status).toBe(200);
  });

  it("without a grace period the losing request is treated as theft (the trade-off)", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email, strictApp);

    const results = await Promise.all([refresh(token, strictApp), refresh(token, strictApp)]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200)!;
    expect(loser.body.error.code).toBe("REFRESH_TOKEN_REUSED");
    expect((await getSession(sessionId)).revoked).toBe(true);
  });
});

describe("POST /api/v1/auth/refresh: invalid input", () => {
  it("returns 401 REFRESH_TOKEN_MISSING without a cookie", async () => {
    const res = await refresh(undefined);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REFRESH_TOKEN_MISSING");
  });

  it("returns 401 INVALID_REFRESH_TOKEN for a token we never issued, and clears the cookie", async () => {
    const res = await refresh("A".repeat(43));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect(isCleared(res)).toBe(true);
  });

  it("rejects a revoked session", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);
    await db.update(sessions).set({ revoked: true }).where(eq(sessions.id, sessionId));

    const res = await refresh(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects an expired session and does not rotate it", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionId));

    const res = await refresh(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect((await getSession(sessionId)).refreshTokenHash).toBe(hashRefreshToken(token));
  });

  it("does not accept the token from the request body or the Authorization header", async () => {
    const user = await makeUser();
    const { token } = await loginAs(user.email);
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Authorization", `Bearer ${token}`)
      .send({ refreshToken: token, refresh_token: token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REFRESH_TOKEN_MISSING");
  });
});

describe("POST /api/v1/auth/refresh: account status", () => {
  it("revokes the session and returns 403 when the user was suspended after login", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));

    const res = await refresh(token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(isCleared(res)).toBe(true);
    expect((await getSession(sessionId)).revoked).toBe(true);
  });
});
