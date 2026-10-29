import { describe, it, expect } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, registerBody } from "./auth.schemas.js";

const valid = { email: "ada@example.com", password: "a-long-enough-password" };

describe("registerBody", () => {
  it("accepts a minimal valid body", () => {
    const parsed = registerBody.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("trims and lowercases the email", () => {
    expect(registerBody.parse({ ...valid, email: "  Ada.Lovelace@Example.COM " }).email).toBe(
      "ada.lovelace@example.com",
    );
  });

  it("rejects malformed emails", () => {
    for (const email of ["", "plain", "a@", "@b.com", "a b@c.com"]) {
      expect(registerBody.safeParse({ ...valid, email }).success, email).toBe(false);
    }
  });

  it("rejects an email longer than 254 characters", () => {
    const email = `${"a".repeat(250)}@x.com`;
    expect(registerBody.safeParse({ ...valid, email }).success).toBe(false);
  });

  it("enforces the password length boundaries", () => {
    const ok = (n: number) => registerBody.safeParse({ ...valid, password: "x".repeat(n) }).success;
    expect(ok(PASSWORD_MIN_LENGTH - 1)).toBe(false);
    expect(ok(PASSWORD_MIN_LENGTH)).toBe(true);
    expect(ok(PASSWORD_MAX_LENGTH)).toBe(true);
    expect(ok(PASSWORD_MAX_LENGTH + 1)).toBe(false);
  });

  it("does not alter the password (no trimming)", () => {
    const password = "  spaces are part of it  ";
    expect(registerBody.parse({ ...valid, password }).password).toBe(password);
  });

  it("requires both email and password", () => {
    expect(registerBody.safeParse({}).success).toBe(false);
    expect(registerBody.safeParse({ email: valid.email }).success).toBe(false);
    expect(registerBody.safeParse({ password: valid.password }).success).toBe(false);
  });

  it("rejects non-string values instead of coercing them", () => {
    expect(registerBody.safeParse({ ...valid, password: 123456789012 }).success).toBe(false);
    expect(registerBody.safeParse({ ...valid, email: ["a@b.com"] }).success).toBe(false);
  });

  it("trims displayName, and rejects empty or oversized ones", () => {
    expect(registerBody.parse({ ...valid, displayName: "  Ada  " }).displayName).toBe("Ada");
    expect(registerBody.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
    expect(registerBody.safeParse({ ...valid, displayName: "x".repeat(101) }).success).toBe(false);
  });

  it("strips unknown fields so clients cannot set status or id (mass assignment)", () => {
    const parsed = registerBody.parse({ ...valid, status: "suspended", id: "x", isAdmin: true });
    expect(parsed).toEqual(valid);
    expect(parsed).not.toHaveProperty("status");
  });
});
