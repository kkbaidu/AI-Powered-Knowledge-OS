import { describe, it, expect } from "vitest";
import pino from "pino";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler.js";
import { notFound } from "./notFound.js";
import { requestId } from "./requestId.js";
import { NotFoundError, PermissionError, ValidationError } from "../../types/errors.js";
import { buildLoggerOptions } from "../../logger.js";

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


describe("errorHandler: body parser client errors", () => {
  const app = buildApp((a) => a.post("/echo", (req, res) => res.json(req.body)));

  it("returns 415, not 500, for an unsupported charset", async () => {
    // body-parser only accepts utf-* charsets; anything else is its 415 "charset.unsupported"
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json; charset=iso-8859-1")
      .send("{}");

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 415, not 500, for an unsupported Content-Encoding", async () => {
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "foo")
      .send("{}");

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("maps any other 4xx body-parser failure to a 422 INVALID_BODY, never a 500", async () => {
    const aborted = Object.assign(new Error("request aborted"), { type: "request.aborted", status: 400 });
    const app = buildApp((a) =>
      a.get("/aborted", () => {
        throw aborted;
      }),
    );

    const res = await request(app).get("/aborted");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("does not treat a 5xx with a type field as a client error", async () => {
    const app = buildApp((a) =>
      a.get("/x", () => {
        throw Object.assign(new Error("db"), { type: "something", status: 500 });
      }),
    );
    expect((await request(app).get("/x")).status).toBe(500);
  });

  it("still maps the known cases the same way", async () => {
    const broken = await request(app).post("/echo").set("Content-Type", "application/json").send("{ nope");
    expect(broken.status).toBe(422);
    expect(broken.body.error.code).toBe("MALFORMED_JSON");
  });
});

describe("errorHandler: what reaches the log for database failures", () => {
  const EMAIL = "victim@example.com";
  const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";

  // The real production logger options, writing to memory, so redaction and serializers
  // are exactly what runs in production.
  function appWithCapturedLogs(thrown: unknown) {
    const lines: string[] = [];
    const log = pino(buildLoggerOptions({ level: "debug", pretty: false }), {
      write: (line: string) => void lines.push(line),
    });
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.log = log;
      next();
    });
    app.get("/boom", () => {
      throw thrown;
    });
    app.use(errorHandler);
    return { app, output: () => lines.join("\n") };
  }

  const pgError = () =>
    Object.assign(new Error("terminating connection due to administrator command"), {
      severity: "FATAL",
      code: "57P01",
      detail: `Key (email)=(${EMAIL}) already exists.`,
      where: `parameter $1 = '${EMAIL}'`,
    });

  it("does not log the SQL parameters of a failed Drizzle query (email, password hash)", async () => {
    const failure = new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      [EMAIL, HASH],
      pgError(),
    );
    const { app, output } = appWithCapturedLogs(failure);

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(output()).not.toContain(EMAIL);
    expect(output()).not.toContain("argon2id");
    expect(output()).not.toContain(HASH);
  });

  it("still logs enough to debug: the SQL text, the SQLSTATE and the driver message", async () => {
    const failure = new DrizzleQueryError('insert into "users" ("email") values ($1)', [EMAIL], pgError());
    const { app, output } = appWithCapturedLogs(failure);

    await request(app).get("/boom");

    expect(output()).toContain('insert into \\"users\\"');
    expect(output()).toContain("57P01");
    expect(output()).toContain("terminating connection due to administrator command");
  });

  it("drops the `detail` and `where` fields of a raw Postgres error too", async () => {
    const { app, output } = appWithCapturedLogs(pgError());

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(output()).not.toContain(EMAIL);
    expect(output()).toContain("57P01");
  });

  it("leaves ordinary errors untouched", async () => {
    const { app, output } = appWithCapturedLogs(new Error("plain failure"));
    await request(app).get("/boom");
    expect(output()).toContain("plain failure");
  });
});


describe("errorHandler: response already started", () => {
  it("hands the error to Express instead of trying to send a second response", () => {
    const err = new Error("late failure");
    let forwarded: unknown;
    errorHandler(err, {} as express.Request, { headersSent: true } as express.Response, (e?: unknown) => {
      forwarded = e;
    });
    expect(forwarded).toBe(err);
  });
});
