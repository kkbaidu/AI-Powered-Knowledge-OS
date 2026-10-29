import { describe, it, expect } from "vitest";
import { hash } from "@node-rs/argon2";
import { ARGON2_POLICY, hashPassword, needsRehash, verifyPassword } from "./passwords.js";

describe("hashPassword", () => {
  it("produces an Argon2id PHC string with the policy parameters", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(h).not.toContain("correct horse");
  });

  it("uses a fresh salt each time, so equal passwords give different hashes", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const h = await hashPassword("s3cret-Passw0rd");
    expect(await verifyPassword(h, "s3cret-Passw0rd")).toBe(true);
    expect(await verifyPassword(h, "s3cret-Passw0rD")).toBe(false);
    expect(await verifyPassword(h, "")).toBe(false);
  });

  it("handles unicode and long passwords (no bcrypt-style 72 byte truncation)", async () => {
    const long = "é".repeat(100);
    const h = await hashPassword(long);
    expect(await verifyPassword(h, long)).toBe(true);
    expect(await verifyPassword(h, "é".repeat(99))).toBe(false);
  });

  it("returns false, without throwing, when there is no stored hash", async () => {
    expect(await verifyPassword(null, "anything")).toBe(false);
    expect(await verifyPassword(undefined, "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });

  it("throws on a malformed stored hash instead of treating it as a wrong password", async () => {
    await expect(verifyPassword("not-a-real-hash", "x")).rejects.toThrow();
  });
});

describe("needsRehash", () => {
  it("is false for a hash made with the current policy", async () => {
    expect(needsRehash(await hashPassword("pw"))).toBe(false);
  });

  it("is true for weaker memory or time cost", async () => {
    const weakMemory = await hash("pw", { ...ARGON2_POLICY, memoryCost: 8192 });
    const weakTime = await hash("pw", { ...ARGON2_POLICY, timeCost: 1 });
    expect(needsRehash(weakMemory)).toBe(true);
    expect(needsRehash(weakTime)).toBe(true);
  });

  it("is true for a different algorithm", async () => {
    const argon2i = await hash("pw", { ...ARGON2_POLICY, algorithm: 1 });
    expect(needsRehash(argon2i)).toBe(true);
  });
});
