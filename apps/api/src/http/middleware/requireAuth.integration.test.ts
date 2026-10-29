import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { config } from "../../config.js";
import { createPostgresPool } from "../../infra/postgres.js";
import { createDb } from "../../db/client.js";
import { sessions, users } from "../../db/schema/index.js";
import { assertDatabaseReady, unique } from "../../test/integration.js";
import { testAuthConfig } from "../../test/auth.js";
import { signAccessToken } from "../../auth/accessTokens.js";
import { generateRefreshToken, hashRefreshToken } from "../../auth/tokens.js";
import { errorHandler } from "./errorHandler.js";
import { requireAuth } from "./requireAuth.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);

// The same protected handler mounted twice: trusting the token, and checking the session.
const app = express();
const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true });
app.get("/stateless", requireAuth({ auth: testAuthConfig, db }), ok);
app.get("/strict", requireAuth({ auth: testAuthConfig, db }, { checkSession: true }), ok);
app.use(errorHandler);

const createdUserIds: string[] = [];

async function makeSession(userOverrides: Partial<typeof users.$inferInsert> = {}) {
  const [user] = await db
    .insert(users)
    .values({ email: `${unique("mw")}@example.com`, status: "active", ...userOverrides })
    .returning();
  createdUserIds.push(user!.id);
  const [session] = await db
    .insert(sessions)
    .values({
      userId: user!.id,
      refreshTokenHash: hashRefreshToken(generateRefreshToken()),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const accessToken = await signAccessToken(
    { userId: user!.id, sessionId: session!.id },
    testAuthConfig,
  );
  return { user: user!, session: session!, accessToken };
}

const get = (path: string, accessToken: string) =>
  request(app).get(path).set("Authorization", `Bearer ${accessToken}`);

beforeAll(() => assertDatabaseReady(pool));
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await pool.end();
});

describe("requireAuth({ checkSession: true })", () => {
  it("allows a live session", async () => {
    const { accessToken } = await makeSession();
    expect((await get("/strict", accessToken)).status).toBe(200);
  });

  it("rejects a revoked session at once, while the stateless mode still accepts the token", async () => {
    const { session, accessToken } = await makeSession();
    await db.update(sessions).set({ revoked: true }).where(eq(sessions.id, session.id));

    const strict = await get("/strict", accessToken);
    expect(strict.status).toBe(401);
    expect(strict.body.error.code).toBe("SESSION_REVOKED");
    expect(strict.headers["www-authenticate"]).toContain("invalid_token");

    // the documented trade-off: a signed token is trusted until it expires
    expect((await get("/stateless", accessToken)).status).toBe(200);
  });

  it("rejects an expired session", async () => {
    const { session, accessToken } = await makeSession();
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, session.id));

    const res = await get("/strict", accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("rejects a session that has been deleted", async () => {
    const { session, accessToken } = await makeSession();
    await db.delete(sessions).where(eq(sessions.id, session.id));

    const res = await get("/strict", accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("returns 403 for a user suspended after the token was issued", async () => {
    const { user, accessToken } = await makeSession();
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));

    const strict = await get("/strict", accessToken);
    expect(strict.status).toBe(403);
    expect(strict.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect((await get("/stateless", accessToken)).status).toBe(200); // stale until expiry
  });

  it("rejects a token whose session belongs to a different user", async () => {
    const a = await makeSession();
    const b = await makeSession();
    // Not forgeable without the secret; this proves the sub/sid binding is still enforced.
    const mismatched = await signAccessToken(
      { userId: a.user.id, sessionId: b.session.id },
      testAuthConfig,
    );

    const res = await get("/strict", mismatched);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });
});
