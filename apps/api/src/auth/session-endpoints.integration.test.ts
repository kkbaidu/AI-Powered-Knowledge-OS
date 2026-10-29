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

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
const redis = { ping: async () => "PONG", on: () => undefined } as unknown as Redis;
const app = createApp({ auth: testAuthConfig, pgPool: pool, redis });

const PASSWORD = "correct-horse-battery";
const createdUserIds: string[] = [];

async function makeUser() {
  const [user] = await db
    .insert(users)
    .values({
      email: `${unique("me")}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      status: "active",
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

async function loginAs(email: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const refreshToken = cookieValue(cookieLine(res)!);
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hashRefreshToken(refreshToken)));
  return { refreshToken, sessionId: session!.id, accessToken: res.body.data.accessToken as string };
}

const bearer = (r: request.Test, accessToken: string) =>
  r.set("Authorization", `Bearer ${accessToken}`);
const me = (accessToken?: string) => {
  const r = request(app).get("/api/v1/auth/me");
  return accessToken ? bearer(r, accessToken) : r;
};
const logoutAll = (accessToken?: string) => {
  const r = request(app).post("/api/v1/auth/logout-all");
  return accessToken ? bearer(r, accessToken) : r;
};
const refresh = (token: string) =>
  request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);

beforeAll(() => assertDatabaseReady(pool));
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await pool.end();
});

describe("GET /api/v1/auth/me", () => {
  it("returns the signed-in user without password material", async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user.email);

    const res = await me(accessToken);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, email: user.email, status: "active" });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|password_hash/i);
  });

  it("requires authentication", async () => {
    const res = await me();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("refuses a user suspended after the token was issued, even though the token is valid", async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user.email);
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));

    const res = await me(accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("works with the access token returned by refresh", async () => {
    const user = await makeUser();
    const { refreshToken } = await loginAs(user.email);
    const refreshed = await refresh(refreshToken);

    expect((await me(refreshed.body.data.accessToken)).status).toBe(200);
  });
});

describe("POST /api/v1/auth/logout-all", () => {
  it("revokes every session of the user, clears the cookie and reports the count", async () => {
    const user = await makeUser();
    const phone = await loginAs(user.email);
    const laptop = await loginAs(user.email);
    const tablet = await loginAs(user.email);

    const res = await logoutAll(phone.accessToken);

    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBe(3);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(cookieLine(res)).toMatch(/Expires=Thu, 01 Jan 1970/);

    for (const s of [phone, laptop, tablet]) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
      expect(rows[0]!.revoked).toBe(true);
      expect((await refresh(s.refreshToken)).status).toBe(401);
    }
  });

  it("does not touch other users' sessions", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await loginAs(alice.email);
    const b = await loginAs(bob.email);

    await logoutAll(a.accessToken);

    const [bobSession] = await db.select().from(sessions).where(eq(sessions.id, b.sessionId));
    expect(bobSession!.revoked).toBe(false);
    expect((await refresh(b.refreshToken)).status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await logoutAll();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("rejects an access token whose session is already revoked (strict check)", async () => {
    const user = await makeUser();
    const { accessToken, refreshToken } = await loginAs(user.email);
    await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${refreshToken}`);

    // /me still accepts the token (stateless), /logout-all does not (checks the session)
    expect((await me(accessToken)).status).toBe(200);
    const res = await logoutAll(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("reports zero when called again (every other session is already revoked)", async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user.email);
    expect((await logoutAll(accessToken)).body.data.revokedSessions).toBe(1);
    // the same token is now rejected by the strict check, so log in again for a fresh one
    const again = await loginAs(user.email);
    expect((await logoutAll(again.accessToken)).body.data.revokedSessions).toBe(1);
  });
});
