import { createServer } from "node:http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { createPostgresPool } from "./infra/postgres.js";
import { createRedisClient } from "./infra/redis.js";

async function main() {
  const pgPool = createPostgresPool(config.postgres);
  const redis = createRedisClient(config.redis);

  const app = createApp({ pgPool, redis });
  const server = createServer(app);

  server.listen(config.port, () => {
    logger.info(`Atlas API listening on port ${config.port}`);
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(async () => {
      logger.info("HTTP server closed, no longer accepting connections");
      await pgPool.end();
      redis.disconnect();
      logger.info("Connections closed. Exiting.");
      process.exit(0);
    });

    // Safety net: if something hangs, don't wait forever
    setTimeout(() => {
      logger.error("Forced shutdown after 10s timeout");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error(err, "Failed to start server");
  process.exit(1);
});