import type { NextFunction, Request, Response } from "express";
import type { RateLimiter } from "../../infra/rateLimiter.js";
import { logger } from "../../logger.js";
import { RateLimitError } from "../../types/errors.js";

// The address rate limits are keyed on. req.ip honours the app's "trust proxy" setting:
// with 0 trusted hops it is the TCP peer and X-Forwarded-For is ignored, so a client
// cannot dodge a limit by inventing that header. Behind a real proxy the hop count must
// be configured (TRUST_PROXY_HOPS) or every user shares the proxy's address and one
// person's traffic limits everyone.
export function clientIp(req: Request): string {
  const ip = req.ip;
  if (!ip) return "unknown";
  // Dual-stack sockets report IPv4 clients as ::ffff:1.2.3.4. Same client, one bucket.
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

export interface RateLimitRuleSpec {
  // Namespaces the counter ("login", "register") so routes never share a budget by accident.
  name: string;
  limit: number;
  windowSeconds: number;
  // What the limit is per: an IP, an IP+email pair. Must not contain raw PII (hash it).
  key: (req: Request, res: Response) => string;
}

export const ruleKey = (rule: RateLimitRuleSpec, req: Request, res: Response): string =>
  `${rule.name}:${rule.key(req, res)}`;

// Rules run in order and the first to block ends the request with 429 + Retry-After.
//
// Fails OPEN: if the limiter itself errors (Redis down), the request is allowed and the
// failure is logged at error level. The alternative, failing closed, turns a Redis outage
// into a full login outage. The cost is that brute-force protection is off while Redis is
// down; password hashing cost and monitoring on this log line are the backstop.
export function rateLimit(limiter: RateLimiter, rules: RateLimitRuleSpec[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const log = req.log ?? logger;

    for (const rule of rules) {
      let result;
      try {
        result = await limiter.consume(ruleKey(rule, req, res), rule);
      } catch (err) {
        log.error({ err, rule: rule.name }, "Rate limiter unavailable, allowing request");
        continue;
      }

      if (!result.allowed) {
        // Rule name and IP only. Never the key: it can embed a hashed email.
        log.warn({ rule: rule.name, ip: clientIp(req) }, "Rate limit exceeded");
        res.set("Retry-After", String(result.retryAfterSeconds));
        throw new RateLimitError(result.retryAfterSeconds);
      }
    }
    next();
  };
}

// Forgive a rule's counter (e.g. after a successful login). Best effort: failing to reset
// must never turn a successful login into an error.
export async function resetRateLimit(
  limiter: RateLimiter,
  rule: RateLimitRuleSpec,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    await limiter.reset(ruleKey(rule, req, res));
  } catch (err) {
    (req.log ?? logger).error({ err, rule: rule.name }, "Rate limiter reset failed");
  }
}
