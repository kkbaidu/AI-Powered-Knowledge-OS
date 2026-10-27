import type { Request, Response, NextFunction } from "express";
import { NotFoundError } from "../../types/errors.js";

// Unmatched routes go through the same error pipeline as everything else, so the
// 404 body can never drift from the standard error shape.
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`, "ROUTE_NOT_FOUND"));
}
