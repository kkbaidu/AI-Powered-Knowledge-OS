import express, { type Express } from "express";
import { requestId } from "./http/middleware/requestId.js";
import { httpLogger } from "./http/middleware/httpLogger.js";
import { errorHandler } from "./http/middleware/errorHandler.js";
import { notFound } from "./http/middleware/notFound.js";
import type { Config } from "./config.js";
import { healthRouter, type HealthDeps } from "./http/routes/health.js";
import { authRouter } from "./http/routes/auth.js";
import { createDb } from "./db/client.js";
import type { RateLimiter } from "./infra/rateLimiter.js";
import type { AuthRateLimits } from "./auth/rateLimitPolicy.js";

// Everything the app needs injected. Config is passed in (not imported) so tests can
// build an app with their own settings.
export type AppDependencies = HealthDeps & {
  auth: Config["auth"];
  rateLimiter: RateLimiter;
  // Override the default limits (tests use tiny ones).
  rateLimits?: AuthRateLimits;
  // Reverse proxies in front of the API. 0 ignores X-Forwarded-For (see config.ts).
  trustProxyHops?: number;
};

// Exported so a test can prove the largest legitimate auth body still fits.
export const AUTH_BODY_LIMIT = "4kb";

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by"); // do not advertise the framework
  // Decides which address req.ip reports, and so who a rate limit counts as "one client".
  app.set("trust proxy", deps.trustProxyHops ?? false);

  app.use(requestId);
  app.use(httpLogger);
  // The auth routes are unauthenticated and their largest legitimate body (a register
  // request with every field at its maximum, fully JSON-escaped) is under 2 KB. Parse them
  // with a 4 KB cap BEFORE the general parser; body-parser skips a request that is already
  // parsed. Without this, anyone could make us buffer and parse 1 MB per request on
  // /login and /register, and requests failing validation never consume rate-limit budget.
  app.use("/api/v1/auth", express.json({ limit: AUTH_BODY_LIMIT }));
  app.use(express.json({ limit: "1mb" })); // oversize bodies become 413 via the error handler

  // One Drizzle instance wrapping the shared pool (see db/client.ts).
  const db = createDb(deps.pgPool);

  app.use("/api/v1", healthRouter(deps));
  app.use("/api/v1/auth", authRouter({
      db,
      auth: deps.auth,
      rateLimiter: deps.rateLimiter,
      ...(deps.rateLimits ? { rateLimits: deps.rateLimits } : {}),
    }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}