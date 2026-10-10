import { Redis } from "ioredis";
import type { Config } from "../config.js";

export function createRedisClient(cfg: Config["redis"]): Redis {
  return new Redis({
    host: cfg.host,
    port: cfg.port,
    maxRetriesPerRequest: 3,
  });
}