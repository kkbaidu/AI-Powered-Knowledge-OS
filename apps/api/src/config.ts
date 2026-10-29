import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  POSTGRES_HOST: z.string().default("localhost"),

  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_HOST: z.string().default("localhost"),

  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive(),
  MINIO_HOST: z.string().default("localhost"),

  // No default on purpose: a built-in secret would be a known secret. HS256 needs a
  // key at least as long as the hash output (32 bytes) to be as strong as it claims.
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Lifetimes in seconds. Access tokens are short because they cannot be revoked
  // (verified without a DB hit); refresh tokens are long because they are revocable.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),
}).refine((e) => e.REFRESH_TOKEN_TTL_SECONDS > e.ACCESS_TOKEN_TTL_SECONDS, {
  path: ["REFRESH_TOKEN_TTL_SECONDS"],
  message: "must be longer than ACCESS_TOKEN_TTL_SECONDS",
});

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

// Pure and testable: takes an env object, returns frozen config or throws ConfigError.
export function parseConfig(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const e = result.data;

  return Object.freeze({
    env: e.NODE_ENV,
    port: e.PORT,
    isProduction: e.NODE_ENV === "production",

    postgres: Object.freeze({
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
      database: e.POSTGRES_DB,
    }),

    redis: Object.freeze({
      host: e.REDIS_HOST,
      port: e.REDIS_PORT,
    }),

    minio: Object.freeze({
      host: e.MINIO_HOST,
      port: e.MINIO_PORT,
      rootUser: e.MINIO_ROOT_USER,
      rootPassword: e.MINIO_ROOT_PASSWORD,
    }),

    auth: Object.freeze({
      accessTokenSecret: e.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL_SECONDS,
    }),
  });
}

export type Config = ReturnType<typeof parseConfig>;

// Fail fast: a bad environment stops the process at boot with a clear message,
// instead of surfacing as a confusing error on the first request that needs it.
function loadConfig(): Config {
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export const config = loadConfig();
