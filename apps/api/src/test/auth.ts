import type { Config } from "../config.js";

// Auth settings for tests: realistic values, and a secret that is not used anywhere real.
export const testAuthConfig: Config["auth"] = Object.freeze({
  accessTokenSecret: "test-only-secret-that-is-at-least-32-characters",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  secureCookies: false,
});
