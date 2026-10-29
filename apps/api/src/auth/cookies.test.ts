import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { readCookie } from "./cookies.js";

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as Request;

describe("readCookie", () => {
  it("reads a single cookie", () => {
    expect(readCookie(req("refresh_token=abc123"), "refresh_token")).toBe("abc123");
  });

  it("finds the right cookie among several, ignoring spaces", () => {
    const header = "theme=dark;  refresh_token=abc_123-XYZ ; other=1";
    expect(readCookie(req(header), "refresh_token")).toBe("abc_123-XYZ");
  });

  it("returns undefined when the header or the cookie is absent", () => {
    expect(readCookie(req(), "refresh_token")).toBeUndefined();
    expect(readCookie(req("theme=dark"), "refresh_token")).toBeUndefined();
    expect(readCookie(req(""), "refresh_token")).toBeUndefined();
  });

  it("does not match on a name prefix or suffix", () => {
    expect(readCookie(req("x_refresh_token=nope; refresh_token_2=nope"), "refresh_token")).toBeUndefined();
  });

  it("treats an empty value as absent", () => {
    expect(readCookie(req("refresh_token="), "refresh_token")).toBeUndefined();
  });

  it("returns undefined, without throwing, on a malformed percent escape", () => {
    expect(readCookie(req("refresh_token=%E0%A4%A"), "refresh_token")).toBeUndefined();
  });

  it("ignores parts with no equals sign", () => {
    expect(readCookie(req("garbage; refresh_token=ok"), "refresh_token")).toBe("ok");
  });
});
