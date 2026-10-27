import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler.js";
import { notFound } from "./notFound.js";
import { requestId } from "./requestId.js";
import { NotFoundError, PermissionError, ValidationError } from "../../types/errors.js";

function buildApp(register: (app: express.Express) => void) {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  register(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("renders an operational AppError in the standard shape", async () => {
    const app = buildApp((a) =>
      a.get("/doc", () => {
        throw new NotFoundError("Document does not exist", "DOCUMENT_NOT_FOUND");
      }),
    );

    const res = await request(app).get("/doc");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: "DOCUMENT_NOT_FOUND", message: "Document does not exist" },
    });
  });

  it("includes details for validation errors", async () => {
    const details = [{ path: "email", message: "Invalid email" }];
    const app = buildApp((a) =>
      a.get("/v", () => {
        throw new ValidationError("Invalid input", details);
      }),
    );

    const res = await request(app).get("/v");

    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual(details);
  });

  it("returns 403 for permission errors", async () => {
    const app = buildApp((a) =>
      a.get("/p", () => {
        throw new PermissionError();
      }),
    );
    const res = await request(app).get("/p");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_ERROR");
  });

  it("hides the message of unexpected errors and returns a generic 500", async () => {
    const app = buildApp((a) =>
      a.get("/boom", () => {
        throw new Error("password=hunter2 leaked in stack");
      }),
    );

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  // Express 5 forwards rejected promises to the error handler, so no
  // asyncHandler wrapper is needed (it was required in Express 4).
  it("catches errors thrown inside async route handlers", async () => {
    const app = buildApp((a) =>
      a.get("/async", async () => {
        await Promise.resolve();
        throw new NotFoundError("missing async", "THING_NOT_FOUND");
      }),
    );

    const res = await request(app).get("/async");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("THING_NOT_FOUND");
  });

  it("returns 422 MALFORMED_JSON, not 500, for a broken JSON body", async () => {
    const app = buildApp((a) => a.post("/echo", (req, res) => void res.json(req.body)));

    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"email": ');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });

  it("returns the standard shape for unknown routes", async () => {
    const app = buildApp(() => undefined);
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("sets an X-Request-Id header on error responses", async () => {
    const app = buildApp(() => undefined);
    const res = await request(app).get("/nope");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
