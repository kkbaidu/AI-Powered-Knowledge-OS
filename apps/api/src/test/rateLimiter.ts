import type { RateLimiter, RateLimitResult, RateLimitRule } from "../infra/rateLimiter.js";

// Never limits. Used by tests that are not about rate limiting, so they need no Redis.
export const noopRateLimiter: RateLimiter = {
  consume: async (_key, rule): Promise<RateLimitResult> => ({
    allowed: true,
    remaining: rule.limit,
    retryAfterSeconds: 0,
  }),
  reset: async () => undefined,
};

// Same sliding-window-log semantics as the Redis implementation, with an injectable clock
// so tests can move time instead of sleeping.
export function createMemoryRateLimiter(now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
      const windowMs = rule.windowSeconds * 1000;
      const t = now();
      const live = (hits.get(key) ?? []).filter((ts) => ts > t - windowMs);
      if (live.length < rule.limit) {
        live.push(t);
        hits.set(key, live);
        return { allowed: true, remaining: rule.limit - live.length, retryAfterSeconds: 0 };
      }
      hits.set(key, live);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((live[0]! + windowMs - t) / 1000)),
      };
    },
    async reset(key: string): Promise<void> {
      hits.delete(key);
    },
  } satisfies RateLimiter;
}
