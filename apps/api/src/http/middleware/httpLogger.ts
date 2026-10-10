import { pinoHttp } from "pino-http";
import { logger } from "../../logger.js";

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? randomFallbackId(),
});

function randomFallbackId(): string {
  return crypto.randomUUID();
}