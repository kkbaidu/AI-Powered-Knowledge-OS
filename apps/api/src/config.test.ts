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
  JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-chars-long",
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
    expect(Object.isFrozen(cfg.auth)).toBe(true);
  });
});

describe("parseConfig: auth", () => {
  it("defaults to a 15 minute access token and a 30 day refresh token", () => {
    const cfg = parseConfig(validEnv);
    expect(cfg.auth.accessTokenTtlSeconds).toBe(900);
    expect(cfg.auth.refreshTokenTtlSeconds).toBe(2_592_000);
    expect(cfg.auth.accessTokenSecret).toBe(validEnv.JWT_ACCESS_SECRET);
  });

  it("defaults the refresh reuse grace period to 10 seconds and allows 0 to disable it", () => {
    expect(parseConfig(validEnv).auth.refreshReuseGraceSeconds).toBe(10);
    expect(
      parseConfig({ ...validEnv, REFRESH_REUSE_GRACE_SECONDS: "0" }).auth.refreshReuseGraceSeconds,
    ).toBe(0);
    expect(() => parseConfig({ ...validEnv, REFRESH_REUSE_GRACE_SECONDS: "-1" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...validEnv, REFRESH_REUSE_GRACE_SECONDS: "2.5" })).toThrow(ConfigError);
  });

  it("only marks cookies Secure in production", () => {
    expect(parseConfig(validEnv).auth.secureCookies).toBe(false);
    expect(parseConfig({ ...validEnv, NODE_ENV: "test" }).auth.secureCookies).toBe(false);
    expect(parseConfig({ ...validEnv, NODE_ENV: "production" }).auth.secureCookies).toBe(true);
  });

  it("coerces TTL overrides to numbers", () => {
    const cfg = parseConfig({
      ...validEnv,
      ACCESS_TOKEN_TTL_SECONDS: "60",
      REFRESH_TOKEN_TTL_SECONDS: "3600",
    });
    expect(cfg.auth.accessTokenTtlSeconds).toBe(60);
    expect(cfg.auth.refreshTokenTtlSeconds).toBe(3600);
  });

  it("requires JWT_ACCESS_SECRET (there is no default)", () => {
    const broken: Record<string, string | undefined> = { ...validEnv };
    delete broken.JWT_ACCESS_SECRET;
    expect(() => parseConfig(broken)).toThrow(ConfigError);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(() => parseConfig({ ...validEnv, JWT_ACCESS_SECRET: "x".repeat(31) })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ ...validEnv, JWT_ACCESS_SECRET: "x".repeat(32) })).not.toThrow();
  });

  it("rejects non-positive or non-integer TTLs", () => {
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      expect(() => parseConfig({ ...validEnv, ACCESS_TOKEN_TTL_SECONDS: bad })).toThrow(ConfigError);
    }
  });

  it("rejects a refresh TTL that is not longer than the access TTL", () => {
    try {
      parseConfig({
        ...validEnv,
        ACCESS_TOKEN_TTL_SECONDS: "900",
        REFRESH_TOKEN_TTL_SECONDS: "900",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join("\n")).toContain("REFRESH_TOKEN_TTL_SECONDS");
    }
  });
});
