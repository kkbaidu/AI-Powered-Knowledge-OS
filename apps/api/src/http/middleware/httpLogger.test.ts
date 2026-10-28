import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import pino from "pino";
import { buildLoggerOptions } from "../../logger.js";
import { createHttpLogger } from "./httpLogger.js";
import { requestId } from "./requestId.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const logger = pino(buildLoggerOptions({ level: "debug", pretty: false }), stream);
  return { lines, logger };
}

function buildApp(logger: pino.Logger) {
  const app = express();
  app.use(requestId);
  app.use(createHttpLogger(logger));
  // Mounted like the real app: inside a router, req.url loses the mount prefix.
  const api = express.Router();
  api.get("/health/live", (_req, res) => void res.json({ ok: true }));
  app.use("/api/v1", api);
  app.get("/work", (req, res) => {
    req.log.info({ user: { email: "a@x.com", password: "hunter2", refreshToken: "rt-secret" } }, "doing work");
    res.json({ ok: true });
  });
  return app;
}

describe("structured request logging", () => {
  it("puts the request ID on every line, including lines logged by handlers", async () => {
    const { lines, logger } = capture();

    const res = await request(buildApp(logger)).get("/work").set("X-Request-Id", "trace-12345678");
    expect(res.status).toBe(200);

    const mine = lines.filter((l) => l.msg === "doing work" || l.msg === "request completed");
    expect(mine).toHaveLength(2);
    for (const line of mine) expect(line.reqId).toBe("trace-12345678");
  });

  it("never logs Authorization or Cookie headers", async () => {
    const { lines, logger } = capture();

    await request(buildApp(logger))
      .get("/work")
      .set("Authorization", "Bearer super-secret-jwt")
      .set("Cookie", "session=cookie-secret");

    const output = JSON.stringify(lines);
    expect(output).not.toContain("super-secret-jwt");
    expect(output).not.toContain("cookie-secret");
  });

  it("redacts sensitive fields in objects the app logs", async () => {
    const { lines, logger } = capture();

    await request(buildApp(logger)).get("/work");

    const output = JSON.stringify(lines);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("rt-secret");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("a@x.com"); // non-sensitive fields stay useful
  });

  it("logs the full requested path, not the router-relative one", async () => {
    const { lines, logger } = capture();
    const app = buildApp(logger);
    const api = express.Router();
    api.get("/thing", (_req, res) => void res.json({ ok: true }));
    app.use("/api/v1", api);

    await request(app).get("/api/v1/thing");

    const done = lines.find((l) => l.msg === "request completed") as { req: { url: string } };
    expect(done.req.url).toBe("/api/v1/thing");
  });

  it("does not log successful health probes", async () => {
    const { lines, logger } = capture();
    await request(buildApp(logger)).get("/api/v1/health/live");
    expect(lines).toHaveLength(0);
  });
});
