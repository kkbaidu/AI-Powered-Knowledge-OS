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
import { hashPassword } from "./passwords.js";
import { hashRefreshToken } from "./tokens.js";
import { verifyAccessToken } from "./accessTokens.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
const redis = { ping: async () => "PONG", on: () => undefined } as unknown as Redis;
const app = createApp({ auth: testAuthConfig, rateLimiter: noopRateLimiter, pgPool: pool, redis });

const PASSWORD = "correct-horse-battery";
const createdUserIds: string[] = [];

async function makeUser() {
  const [user] = await db
    .insert(users)
    .values({
      email: `${unique("logout")}@example.com`,
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
  const token = cookieValue(cookieLine(res)!);
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hashRefreshToken(token)));
  return { token, sessionId: session!.id, accessToken: res.body.data.accessToken as string };
}

const withCookie = (r: request.Test, token?: string) =>
  token === undefined ? r : r.set("Cookie", `refresh_token=${token}`);
const logout = (token?: string) => withCookie(request(app).post("/api/v1/auth/logout"), token);
const refresh = (token?: string) => withCookie(request(app).post("/api/v1/auth/refresh"), token);

const getSession = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;

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

describe("POST /api/v1/auth/logout", () => {
  it("revokes the session, clears the cookie and returns 204 with no body", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);

    const res = await logout(token);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(isCleared(res)).toBe(true);
    expect(cookieLine(res)).toContain("Path=/api/v1/auth"); // must match the original or the browser keeps it
    expect((await getSession(sessionId)).revoked).toBe(true);
  });

  it("makes the refresh token unusable afterwards", async () => {
    const user = await makeUser();
    const { token } = await loginAs(user.email);
    await logout(token);

    const res = await refresh(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("ends only the session it was called for", async () => {
    const user = await makeUser();
    const phone = await loginAs(user.email);
    const laptop = await loginAs(user.email);

    await logout(phone.token);

    expect((await getSession(phone.sessionId)).revoked).toBe(true);
    expect((await getSession(laptop.sessionId)).revoked).toBe(false);
    expect((await refresh(laptop.token)).status).toBe(200);
  });

  it("is idempotent: logging out twice succeeds both times", async () => {
    const user = await makeUser();
    const { token } = await loginAs(user.email);

    expect((await logout(token)).status).toBe(204);
    expect((await logout(token)).status).toBe(204);
  });

  it("succeeds with no cookie at all, and still clears it", async () => {
    const res = await logout();
    expect(res.status).toBe(204);
    expect(isCleared(res)).toBe(true);
  });

  it("succeeds for a token we never issued, and revokes nothing", async () => {
    const user = await makeUser();
    const { sessionId } = await loginAs(user.email);

    const res = await logout("A".repeat(43));

    expect(res.status).toBe(204);
    expect((await getSession(sessionId)).revoked).toBe(false);
  });

  it("also ends the session when given the previous token (a logout racing a refresh)", async () => {
    const user = await makeUser();
    const { token: old, sessionId } = await loginAs(user.email);
    const rotated = await refresh(old);
    const current = cookieValue(cookieLine(rotated)!);

    const res = await logout(old);

    expect(res.status).toBe(204);
    expect((await getSession(sessionId)).revoked).toBe(true);
    expect((await refresh(current)).status).toBe(401);
  });

  it("ignores a token supplied in the body or the Authorization header", async () => {
    const user = await makeUser();
    const { token, sessionId } = await loginAs(user.email);

    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({ refreshToken: token });

    expect(res.status).toBe(204);
    expect((await getSession(sessionId)).revoked).toBe(false);
  });

  it("does not invalidate the access token already issued (it is stateless)", async () => {
    // Documents the trade-off recorded in ADR-006: access tokens live until they expire.
    const user = await makeUser();
    const { token, accessToken } = await loginAs(user.email);
    await logout(token);

    await expect(verifyAccessToken(accessToken, testAuthConfig)).resolves.toMatchObject({
      userId: user.id,
    });
  });
});
