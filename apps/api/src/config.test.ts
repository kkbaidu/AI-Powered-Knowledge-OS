import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "./config.js";

const validEnv = {
  POSTGRES_USER: "atlas",
  POSTGRES_PASSWORD: "secret",
  POSTGRES_DB: "atlas",
  POSTGRES_PORT: "5432",
  REDIS_PORT: "6379",
  MINIO_ROOT_USER: "minio",
  MINIO_ROOT_PASSWORD: "miniosecret",
  MINIO_PORT: "9000",
};

describe("parseConfig", () => {
  it("parses a valid environment and coerces numeric strings", () => {
    const cfg = parseConfig(validEnv);
    expect(cfg.postgres.port).toBe(5432);
    expect(cfg.redis.port).toBe(6379);
    expect(cfg.postgres.user).toBe("atlas");
  });

  it("applies defaults for optional values", () => {
    const cfg = parseConfig(validEnv);
    expect(cfg.port).toBe(4000);
    expect(cfg.env).toBe("development");
    expect(cfg.postgres.host).toBe("localhost");
    expect(cfg.isProduction).toBe(false);
  });

  it("throws ConfigError naming every missing variable", () => {
    const broken: Record<string, string | undefined> = { ...validEnv };
    delete broken.POSTGRES_PASSWORD;
    delete broken.REDIS_PORT;
    try {
      parseConfig(broken);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toContain("POSTGRES_PASSWORD");
      expect(issues).toContain("REDIS_PORT");
    }
  });

  it("rejects a malformed port", () => {
    expect(() => parseConfig({ ...validEnv, POSTGRES_PORT: "not-a-number" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...validEnv, POSTGRES_PORT: "-1" })).toThrow(ConfigError);
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => parseConfig({ ...validEnv, NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("returns an immutable config", () => {
    const cfg = parseConfig(validEnv);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.postgres)).toBe(true);
  });
});
