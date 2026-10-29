import type { Redis } from "ioredis";

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  // Requests still allowed in the current window (0 when blocked).
  remaining: number;
  // When blocked: seconds until the oldest counted request leaves the window.
  retryAfterSeconds: number;
}

// What the HTTP layer depends on. The Redis version is production; tests use in-memory
// and no-op versions, so unit tests need no Redis and the middleware has no Redis types.
export interface RateLimiter {
  // Counts this request AND decides, atomically. Counting and checking in one step is
  // what stops a burst of parallel requests from all slipping under the limit.
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

// Sliding window LOG: every allowed request is a timestamped member of a sorted set; the
// window is "the last N ms from now", so there is no fixed boundary to burst across.
//
// Why not a fixed window counter (INCR + EXPIRE)? Cheaper, but a client can send the full
// limit just before the window resets and the full limit again just after: 2x the limit
// inside a second. For 5 password guesses that doubling matters, and the log's memory
// cost is bounded by the limit itself (we only store allowed requests, so at most
// `limit` members per key). For high-volume limits (thousands per window) a sliding
// window COUNTER or a token bucket is the better trade.
//
// The whole thing runs as one Lua script, so it is atomic: Redis executes a script
// without interleaving other commands. Time comes from Redis (TIME), not the API
// servers, so skewed app clocks cannot disagree about when a window ends.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local nonce = ARGV[3]

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. nonce)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfter = tonumber(oldest[2]) + window - now
return {0, 0, retryAfter}
`;

interface SlidingWindowCommand {
  slidingWindowConsume(
    key: string,
    limit: number,
    windowMs: number,
    nonce: string,
  ): Promise<[number, number, number]>;
}

export function createRedisRateLimiter(
  redis: Redis,
  options: { prefix?: string } = {},
): RateLimiter {
  const prefix = options.prefix ?? "rl:";
  // defineCommand registers the script once and calls it by SHA afterwards (EVALSHA), so
  // the script body is not re-sent on every request.
  redis.defineCommand("slidingWindowConsume", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
  const commands = redis as Redis & SlidingWindowCommand;

  return {
    async consume(key, rule) {
      // The nonce makes members unique, so two requests in the same millisecond are both
      // counted instead of overwriting each other in the sorted set.
      const nonce = Math.random().toString(36).slice(2) + process.hrtime.bigint().toString(36);
      const [allowed, remaining, retryAfterMs] = await commands.slidingWindowConsume(
        prefix + key,
        rule.limit,
        rule.windowSeconds * 1000,
        nonce,
      );
      return {
        allowed: allowed === 1,
        remaining,
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    },

    async reset(key) {
      await redis.del(prefix + key);
    },
  };
}
