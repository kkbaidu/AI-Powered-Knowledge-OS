import { describe, it, expect } from "vitest";
import { generateRefreshToken, hashRefreshToken } from "./tokens.js";

describe("generateRefreshToken", () => {
  it("returns 32 random bytes as 43 url-safe base64 characters", () => {
    expect(generateRefreshToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateRefreshToken));
    expect(tokens.size).toBe(1000);
  });
});

describe("hashRefreshToken", () => {
  it("is a deterministic 64 character hex SHA-256, so it can be looked up by equality", () => {
    const t = generateRefreshToken();
    expect(hashRefreshToken(t)).toBe(hashRefreshToken(t));
    expect(hashRefreshToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 test vector", () => {
    expect(hashRefreshToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("differs per token and never equals the token itself", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
    expect(hashRefreshToken(a)).not.toBe(a);
  });
});
