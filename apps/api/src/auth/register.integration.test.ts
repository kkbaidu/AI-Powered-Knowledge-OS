import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import { config } from "../config.js";
import { createApp } from "../app.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createDb } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { assertDatabaseReady, unique } from "../test/integration.js";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);
// Register never touches Redis, so a stub is enough here.
const app = createApp({ pgPool: pool, redis: { ping: async () => "PONG", on: () => undefined } as unknown as Redis });

const createdEmails: string[] = [];
const newEmail = (prefix = "reg") => {
  const email = `${unique(prefix)}@example.com`;
  createdEmails.push(email);
  return email;
};
const PASSWORD = "correct-horse-battery";
const register = (body: unknown) => request(app).post("/api/v1/auth/register").send(body as object);

beforeAll(() => assertDatabaseReady(pool));
afterAll(async () => {
  if (createdEmails.length > 0) await db.delete(users).where(inArray(users.email, createdEmails));
  await pool.end();
});

describe("POST /api/v1/auth/register", () => {
  it("creates an active user and returns it without any password material", async () => {
    const email = newEmail();
    const res = await register({ email, password: PASSWORD, displayName: "Ada" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ email, displayName: "Ada", status: "active" });
    expect(res.body.data.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
  });

  it("stores an Argon2id hash, never the plaintext", async () => {
    const email = newEmail();
    await register({ email, password: PASSWORD });

    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });

  it("normalises the email to lowercase and trims it before storing", async () => {
    const email = newEmail();
    const res = await register({ email: `  ${email.toUpperCase()} `, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(email);
  });

  it("rejects a duplicate email with 409 EMAIL_ALREADY_REGISTERED", async () => {
    const email = newEmail();
    expect((await register({ email, password: PASSWORD })).status).toBe(201);

    const res = await register({ email, password: "a-different-password" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_REGISTERED");
  });

  it("treats emails that differ only by case as the same account", async () => {
    const email = newEmail();
    await register({ email, password: PASSWORD });

    const res = await register({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
  });

  it("lets exactly one of several simultaneous registrations win", async () => {
    const email = newEmail("race");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => register({ email, password: PASSWORD })),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  });

  it("ignores client-supplied status or id (mass assignment)", async () => {
    const email = newEmail();
    const res = await register({
      email,
      password: PASSWORD,
      status: "suspended",
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.status).toBe("active");
    expect(res.body.data.user.id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("returns 422 listing every invalid field, and creates nothing", async () => {
    const res = await register({ email: "not-an-email", password: "short" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "password"]));
    // the submitted password must never be echoed back
    expect(JSON.stringify(res.body)).not.toContain("short\"");
  });

  it("returns 422 MALFORMED_JSON for a broken body", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Content-Type", "application/json")
      .send("{ nope");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });
});
