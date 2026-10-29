import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { signAccessToken, verifyAccessToken } from "./accessTokens.js";
import { AuthError } from "../types/errors.js";

const settings = {
  accessTokenSecret: "unit-test-secret-that-is-at-least-32-chars-long",
  accessTokenTtlSeconds: 900,
};
const claims = { userId: "user-1", sessionId: "session-1" };
const key = (s: string) => new TextEncoder().encode(s);

async function rejection(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    return err as AuthError;
  }
  throw new Error("expected the promise to reject");
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

describe("access tokens", () => {
  it("round-trips the user and session ids", async () => {
    const token = await signAccessToken(claims, settings);
    expect(await verifyAccessToken(token, settings)).toEqual(claims);
  });

  it("carries only sub, sid, iss, aud, iat and exp (no email, roles or other PII)", async () => {
    const payload = decodePayload(await signAccessToken(claims, settings));
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "sid", "sub"]);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
  });

  it("rejects an expired token with the distinct ACCESS_TOKEN_EXPIRED code", async () => {
    const token = await signAccessToken(claims, settings);
    const later = new Date(Date.now() + 901 * 1000);
    const err = await rejection(verifyAccessToken(token, settings, later));
    expect(err.code).toBe("ACCESS_TOKEN_EXPIRED");
    expect(err.statusCode).toBe(401);
  });

  it("accepts a token right up to its expiry", async () => {
    const token = await signAccessToken(claims, settings);
    const almost = new Date(Date.now() + 890 * 1000);
    await expect(verifyAccessToken(token, settings, almost)).resolves.toEqual(claims);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signAccessToken(claims, {
      ...settings,
      accessTokenSecret: "a-completely-different-secret-of-32-chars-plus",
    });
    expect((await rejection(verifyAccessToken(token, settings))).code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("rejects a tampered payload", async () => {
    const [h, , sig] = (await signAccessToken(claims, settings)).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", sid: "x" })).toString("base64url");
    const err = await rejection(verifyAccessToken(`${h}.${forged}.${sig}`, settings));
    expect(err.code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("rejects an algorithm other than HS256, even with the right secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({ sid: "s" })
      .setProtectedHeader({ alg: "HS512" })
      .setSubject("u")
      .setIssuer("atlas-api")
      .setAudience("atlas-api")
      .setExpirationTime(now + 60)
      .sign(key(settings.accessTokenSecret));
    expect((await rejection(verifyAccessToken(hs512, settings))).code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "u", sid: "s" })}.`;
    expect((await rejection(verifyAccessToken(unsigned, settings))).code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("rejects the wrong issuer or audience, and a missing sid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const make = (issuer: string, audience: string, withSid: boolean) =>
      new SignJWT(withSid ? { sid: "s" } : {})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("u")
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(now + 60)
        .sign(key(settings.accessTokenSecret));

    for (const token of [
      await make("someone-else", "atlas-api", true),
      await make("atlas-api", "another-service", true),
      await make("atlas-api", "atlas-api", false),
    ]) {
      expect((await rejection(verifyAccessToken(token, settings))).code).toBe("INVALID_ACCESS_TOKEN");
    }
  });

  it("rejects garbage", async () => {
    for (const junk of ["", "abc", "a.b.c"]) {
      expect((await rejection(verifyAccessToken(junk, settings))).code).toBe("INVALID_ACCESS_TOKEN");
    }
  });
});
