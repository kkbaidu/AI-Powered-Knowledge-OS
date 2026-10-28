import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { logger } from "../../logger.js";

const HEALTH_PREFIX = "/api/v1/health";

// Inside a mounted router Express rewrites req.url to the path *relative to the mount*
// ("/health/live"), and the response can finish before it is restored. originalUrl is
// always the full path the client requested, so use it for matching and logging.
function fullUrl(req: { originalUrl?: string; url?: string }): string {
  return req.originalUrl ?? req.url ?? "";
}

// One access-log line per request, carrying the request ID. Handlers should log
// through `req.log` (a child logger bound to this request) so every line they emit
// carries the same ID automatically.
export function createHttpLogger(baseLogger: Logger = logger) {
  return pinoHttp({
    logger: baseLogger,
    genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
    // Bind the request ID to req.log as a top-level `reqId` field (not nested inside `req`),
    // so every line a handler logs through req.log carries it.
    quietReqLogger: true,
    customAttributeKeys: { reqId: "reqId" },
    // Log only what is needed to trace a request. The default serializer dumps every
    // header, including Authorization and Cookie. Never log headers or bodies.
    serializers: {
      req: (req) => ({ method: req.method, url: fullUrl(req) }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      // Orchestrators poll health endpoints every few seconds; successful probes are noise.
      if (fullUrl(req).startsWith(HEALTH_PREFIX)) return "silent";
      return "info";
    },
  });
}

export const httpLogger = createHttpLogger();
