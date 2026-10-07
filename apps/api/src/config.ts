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
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("❌ Invalid environment configuration:\n");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const env = result.data;

  return Object.freeze({
    env: env.NODE_ENV,
    port: env.PORT,
    isProduction: env.NODE_ENV === "production",

    postgres: Object.freeze({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
    }),

    redis: Object.freeze({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    }),

    minio: Object.freeze({
      host: env.MINIO_HOST,
      port: env.MINIO_PORT,
      rootUser: env.MINIO_ROOT_USER,
      rootPassword: env.MINIO_ROOT_PASSWORD,
    }),
  });
}

export const config = loadConfig();
export type Config = typeof config;