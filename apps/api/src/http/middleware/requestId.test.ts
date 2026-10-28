import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requestId } from "./requestId.js";

const app = express();
app.use(requestId);
app.get("/", (req, res) => void res.json({ id: req.id }));

describe("requestId", () => {
  it("generates a UUID when the client sends none", async () => {
    const res = await request(app).get("/");
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-request-id"]).toBe(res.body.id);
  });

  it("reuses a well-formed incoming ID so traces span services", async () => {
    const res = await request(app).get("/").set("X-Request-Id", "gateway-abc_123.xyz");
    expect(res.body.id).toBe("gateway-abc_123.xyz");
    expect(res.headers["x-request-id"]).toBe("gateway-abc_123.xyz");
  });

  it.each(["short", "has spaces in it", "evil\\u0000chars", "a".repeat(200), "<script>alert(1)</script>"])(
    "replaces an unsafe incoming ID (%s) with a fresh UUID",
    async (bad) => {
      const res = await request(app).get("/").set("X-Request-Id", bad);
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("gives each request its own ID", async () => {
    const a = await request(app).get("/");
    const b = await request(app).get("/");
    expect(a.body.id).not.toBe(b.body.id);
  });
});
