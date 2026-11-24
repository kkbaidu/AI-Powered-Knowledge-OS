import type { Request, Response, NextFunction } from "express";
import { AppError, InternalError, ValidationError } from "../../types/errors.js";
import { DrizzleQueryError } from "drizzle-orm";
import { logger } from "../../logger.js";

// Errors thrown by Express's body parser carry a `type` ("entity.parse.failed",
// "charset.unsupported", "encoding.unsupported", "request.aborted", ...) and the HTTP status
// the parser itself chose. Anything with a 4xx status is the CLIENT's fault, whatever its
// type prefix: matching only "entity." let an unsupported charset or Content-Encoding fall
// through to a 500 and an error-level log that any anonymous caller could trigger.
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    typeof err.type === "string" &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  );
}

// What goes into the log for an unexpected error. Database errors are rewritten because
// they carry user data: Drizzle's message is "Failed query: <sql> params: <values>" (and the
// values are also an enumerable `params` field), so logging the raw error wrote the
// plaintext email and the password HASH of a registration into the logs whenever Postgres
// hiccuped. Field-name redaction in the logger cannot catch values embedded in a message.
// pg's own errors have a `detail` ("Key (email)=(a@b.com) already exists") for the same
// reason. We keep what is needed to debug (SQL text without values, SQLSTATE, constraint,
// table, the driver's message and stack) and drop everything that can hold a value.
interface PgLikeError {
  code?: unknown;
  severity?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
  routine?: unknown;
  message?: unknown;
  stack?: unknown;
}

const isPgError = (err: unknown): err is PgLikeError =>
  typeof err === "object" && err !== null && "severity" in err && "code" in err;

function describePgError(err: PgLikeError) {
  return {
    kind: "DatabaseError",
    message: err.message,
    pgCode: err.code,
    constraint: err.constraint,
    table: err.table,
    column: err.column,
    routine: err.routine,
    stack: err.stack,
  };
}

export function loggableError(err: unknown): unknown {
  if (err instanceof DrizzleQueryError) {
    const cause = err.cause;
    // The driver error goes under `pg`, not `cause`: pino's error serializer follows a
    // `cause` key and would replace our sanitised object with its own rendering.
    return {
      kind: "DrizzleQueryError",
      message: "Database query failed (parameters omitted)",
      query: err.query, // SQL text with $1, $2 placeholders, never the values
      ...(isPgError(cause) ? { pg: describePgError(cause) } : {}),
    };
  }
  if (isPgError(err)) return describePgError(err);
  return err;
}

// Normalize anything that was thrown into an AppError so there is exactly one
// place that decides status code, response shape and log level.
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") {
      return new ValidationError("Request body is not valid JSON", undefined, "MALFORMED_JSON");
    }
    if (err.type === "entity.too.large") {
      return new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large",
        statusCode: 413,
      });
    }
    if (err.status === 415) {
      return new AppError({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Unsupported content type, charset or encoding",
        statusCode: 415,
      });
    }
    return new ValidationError("Request body could not be read", undefined, "INVALID_BODY");
  }

  return new InternalError(err);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Too late to change status/headers; let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  const expose = appError.isOperational;

  // 5xx and non-operational errors are our fault (error); 4xx are the client's (warn).
  // Log the original cause so the stack of the real failure is not lost.
  // req.log is bound to this request's ID; fall back for requests that never reached httpLogger.
  const log = req.log ?? logger;
  const logFields = { err: loggableError(appError.cause ?? appError), code: appError.code, reqId: req.id };
  if (appError.statusCode >= 500 || !expose) {
    log.error(logFields, "Request failed");
  } else {
    log.warn(logFields, "Request failed");
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(expose && appError.details !== undefined ? { details: appError.details } : {}),
    },
  });
}
