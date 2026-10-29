import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { RateLimitRule } from "../infra/rateLimiter.js";
import { clientIp, type RateLimitRuleSpec } from "../http/middleware/rateLimit.js";

export interface AuthRateLimits {
  register: RateLimitRule; // per IP
  loginPerIp: RateLimitRule; // per IP, every attempt
  loginPerIpAndEmail: RateLimitRule; // per IP + target email, cleared by a successful login
}

// Why these shapes:
// - loginPerIpAndEmail (5 per 15 min) is the brute-force brake: it caps guesses at one
//   account from one address. It is keyed on BOTH so an attacker cannot lock a victim out
//   by guessing their email from elsewhere: only their own IP + that email is throttled.
// - loginPerIp (30 per 15 min) stops one address from spraying many emails (credential
//   stuffing) while leaving room for several users behind one office NAT.
// - register (10 per hour per IP) slows mass account creation and email enumeration.
// Deliberately absent: a limit on the email alone. It would stop distributed attacks on one
// account, but any stranger could then lock anyone out. That is a product decision (CAPTCHA,
// step-up checks) recorded in ADR-006, not something to ship by default.
export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = Object.freeze({
  register: { limit: 10, windowSeconds: 60 * 60 },
  loginPerIp: { limit: 30, windowSeconds: 15 * 60 },
  loginPerIpAndEmail: { limit: 5, windowSeconds: 15 * 60 },
});

const perIp = (req: Request) => clientIp(req);

// The email is hashed so Redis keys hold no personal data and have a bounded length.
// (Not a security boundary: it only avoids storing the address.)
const perIpAndEmail = (req: Request, res: Response) => {
  const { body } = res.locals.validated as { body: { email: string } };
  const digest = createHash("sha256").update(body.email).digest("hex").slice(0, 32);
  return `${clientIp(req)}:${digest}`;
};

export function authRateLimitRules(limits: AuthRateLimits) {
  const register: RateLimitRuleSpec = { name: "register:ip", ...limits.register, key: perIp };
  const loginPerIp: RateLimitRuleSpec = { name: "login:ip", ...limits.loginPerIp, key: perIp };
  const loginPerIpAndEmail: RateLimitRuleSpec = {
    name: "login:ip-email",
    ...limits.loginPerIpAndEmail,
    key: perIpAndEmail,
  };
  return { register, loginPerIp, loginPerIpAndEmail };
}
