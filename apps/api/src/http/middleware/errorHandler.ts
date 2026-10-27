import type { Request, Response, NextFunction } from "express";
import { AppError, InternalError, ValidationError } from "../../types/errors.js";
import { logger } from "../../logger.js";

// Errors thrown by Express's body parser carry a `type` like "entity.parse.failed".
function isBodyParserError(err: unknown): err is { type: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    typeof err.type === "string" &&
    err.type.startsWith("entity.")
  );
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
  const logFields = { err: appError.cause ?? appError, code: appError.code, reqId: req.id };
  if (appError.statusCode >= 500 || !expose) {
    logger.error(logFields, "Request failed");
  } else {
    logger.warn(logFields, "Request failed");
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
