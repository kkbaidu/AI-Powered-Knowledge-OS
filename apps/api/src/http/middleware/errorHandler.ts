import type { Request, Response, NextFunction } from "express";
import { AppError } from "../../types/errors.js";
import { logger } from "../../logger.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof AppError && err.isOperational) {
    logger.warn({ err, reqId: req.id }, "Operational error");
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }

  logger.error({ err, reqId: req.id }, "Unhandled error");
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}