import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { validate, type Validated } from "./validate.js";
import { errorHandler } from "./errorHandler.js";

const schemas = {
  body: z.object({ email: z.email(), age: z.number().int().min(18) }),
  params: z.object({ orgId: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/orgs/:orgId/users", validate(schemas), (_req, res) => {
    const { body, params, query } = res.locals.validated as Validated<typeof schemas>;
    res.json({ body, params, query });
  });
  app.use(errorHandler);
  return app;
}

const orgId = "0b0f3a0e-6a39-4f5e-9d3e-1d1d1d1d1d1d";

describe("validate middleware", () => {
  it("passes valid input and exposes parsed, coerced values", async () => {
    const res = await request(buildApp())
      .post(`/orgs/${orgId}/users?limit=5`)
      .send({ email: "a@x.com", age: 30 });

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ limit: 5 }); // "5" coerced to a number
    expect(res.body.body).toEqual({ email: "a@x.com", age: 30 });
  });

  it("applies schema defaults", async () => {
    const res = await request(buildApp())
      .post(`/orgs/${orgId}/users`)
      .send({ email: "a@x.com", age: 30 });
    expect(res.body.query).toEqual({ limit: 20 });
  });

  it("returns the standard VALIDATION_ERROR shape with field details", async () => {
    const res = await request(buildApp())
      .post(`/orgs/${orgId}/users`)
      .send({ email: "not-an-email", age: 30 });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ location: "body", path: "email" }),
    ]);
  });

  it("reports problems from body, params and query together", async () => {
    const res = await request(buildApp())
      .post("/orgs/not-a-uuid/users?limit=1000")
      .send({ email: "bad", age: 5 });

    const locations = new Set(res.body.error.details.map((d: { location: string }) => d.location));
    expect(res.status).toBe(422);
    expect(locations).toEqual(new Set(["body", "params", "query"]));
  });

  it("rejects a missing body instead of crashing", async () => {
    const res = await request(buildApp()).post(`/orgs/${orgId}/users`);
    expect(res.status).toBe(422);
  });
});
