import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- required for Express's declaration-merging pattern to extend Request
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

// A load balancer or API gateway may already have assigned an ID. Reusing it keeps
// one ID across the whole call chain, but the value goes into log lines and a
// response header, so only accept a conservative charset and length. Anything else
// (log-injection attempts, huge values) is replaced with a fresh UUID.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}
