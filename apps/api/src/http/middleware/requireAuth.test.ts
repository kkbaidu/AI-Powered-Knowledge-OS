import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type { Database } from "../../db/client.js";
import { signAccessToken } from "../../auth/accessTokens.js";
import { testAuthConfig } from "../../test/auth.js";
import { errorHandler } from "./errorHandler.js";
import { getAuth, requireAuth } from "./requireAuth.js";

// Stateless mode never touches the database, so a stub is enough here.
const db = {} as Database;
const claims = { userId: "user-1", sessionId: "session-1" };

function makeApp() {
  const app = express();
  app.get("/protected", requireAuth({ auth: testAuthConfig, db }), (_req, res) => {
    res.json({ auth: getAuth(res) });
  });
  app.get("/forgot-middleware", (_req, res) => {
    res.json({ auth: getAuth(res) });
  });
  app.use(errorHandler);
  return app;
}
const app = makeApp();
const token = () => signAccessToken(claims, testAuthConfig);

describe("requireAuth (stateless)", () => {
  it("lets a valid Bearer token through and exposes the caller", async () => {
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual(claims);
  });

  it("accepts the scheme in any case and tolerates extra spaces", async () => {
    const t = await token();
    for (const header of [`bearer ${t}`, `BEARER   ${t}`, `Bearer ${t} `]) {
      expect((await request(app).get("/protected").set("Authorization", header)).status, header).toBe(200);
    }
  });

  it("returns 401 AUTH_REQUIRED and a Bearer challenge when no credentials are sent", async () => {
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="atlas"');
  });

  it("rejects other schemes and empty tokens as AUTH_REQUIRED", async () => {
    for (const header of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer ", `Token ${await token()}`]) {
      const res = await request(app).get("/protected").set("Authorization", header);
      expect(res.status, header).toBe(401);
      expect(res.body.error.code, header).toBe("AUTH_REQUIRED");
    }
  });

  it("returns INVALID_ACCESS_TOKEN with error=invalid_token for a bad token", async () => {
    const res = await request(app).get("/protected").set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("returns the distinct ACCESS_TOKEN_EXPIRED code so clients know to refresh", async () => {
    const expired = await signAccessToken(claims, { ...testAuthConfig, accessTokenTtlSeconds: -60 });
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCESS_TOKEN_EXPIRED");
  });

  it("rejects a token signed with another secret", async () => {
    const forged = await signAccessToken(claims, {
      ...testAuthConfig,
      accessTokenSecret: "another-secret-that-is-also-32-chars-long!!",
    });
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("ignores a token in the query string or a cookie", async () => {
    const t = await token();
    const viaQuery = await request(app).get(`/protected?access_token=${t}`);
    const viaCookie = await request(app).get("/protected").set("Cookie", `access_token=${t}`);
    expect(viaQuery.status).toBe(401);
    expect(viaCookie.status).toBe(401);
  });

  it("does not accept an opaque refresh token as an access token", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${"A".repeat(43)}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_ACCESS_TOKEN");
  });
});

describe("getAuth", () => {
  it("is a 500 (a bug, not a client error) when the route forgot requireAuth", async () => {
    const res = await request(app).get("/forgot-middleware");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});
