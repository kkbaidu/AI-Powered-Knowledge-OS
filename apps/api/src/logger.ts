import pino, { type LoggerOptions } from "pino";
import { config } from "./config.js";

// Keys that must never reach a log line (architecture doc: never log passwords,
// tokens, documents, secrets). Matched at the top level and one level deep, so
// logger.info({ user }) and logger.info({ body }) are both covered.
const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "refreshTokenHash",
  "apiKey",
  "secret",
  "authorization",
  "cookie",
];

export const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function buildLoggerOptions(opts: { level: string; pretty: boolean }): LoggerOptions {
  return {
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: opts.pretty ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  };
}

export const logger = pino(
  buildLoggerOptions({
    // Silent under test so suites stay readable; tests that assert on logs build their own logger.
    level: config.env === "test" ? "silent" : config.isProduction ? "info" : "debug",
    pretty: !config.isProduction && config.env !== "test",
  }),
);
