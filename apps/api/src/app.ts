import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { requestId } from "./http/middleware/requestId.js";
import { httpLogger } from "./http/middleware/httpLogger.js";
import { errorHandler } from "./http/middleware/errorHandler.js";
import { healthRouter } from "./http/routes/health.js";

export interface AppDependencies {
  pgPool: Pool;
  redis: Redis;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(requestId);
  app.use(httpLogger);
  app.use(express.json());

  app.use("/api/v1", healthRouter(deps));

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` },
    });
  });

  app.use(errorHandler);

  return app;
}