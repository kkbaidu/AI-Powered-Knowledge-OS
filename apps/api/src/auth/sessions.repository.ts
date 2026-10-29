import { and, eq, gt, sql } from "drizzle-orm";
import type { DbExecutor } from "../db/client.js";
import { sessions } from "../db/schema/index.js";

export type Session = typeof sessions.$inferSelect;
export type NewSession = Pick<
  typeof sessions.$inferInsert,
  "userId" | "refreshTokenHash" | "deviceInfo" | "ipAddress" | "expiresAt" | "lastUsedAt"
>;

export async function insertSession(executor: DbExecutor, values: NewSession): Promise<Session> {
  const [row] = await executor.insert(sessions).values(values).returning();
  if (!row) throw new Error("Session insert returned no row");
  return row;
}

// THE rotation step, as one atomic statement. It swaps in the new hash and moves the old
// one to previous_token_hash, but only if the presented hash is still the CURRENT one and
// the session is live. Two requests carrying the same token race for the row lock: the
// winner updates it, and when the loser's turn comes Postgres re-checks the WHERE clause
// against the updated row, no longer matches, and returns zero rows. So exactly one
// request can ever rotate a given token. A "SELECT, compare, UPDATE" sequence would let
// both pass the check. `previous_token_hash = refresh_token_hash` reads the OLD value
// because every expression in an UPDATE sees the row as it was before the statement.
export async function rotateSession(
  executor: DbExecutor,
  args: { currentHash: string; newHash: string; now: Date; expiresAt: Date },
): Promise<Session | null> {
  const [row] = await executor
    .update(sessions)
    .set({
      previousTokenHash: sql`${sessions.refreshTokenHash}`,
      refreshTokenHash: args.newHash,
      lastUsedAt: args.now,
      expiresAt: args.expiresAt,
    })
    .where(
      and(
        eq(sessions.refreshTokenHash, args.currentHash),
        eq(sessions.revoked, false),
        gt(sessions.expiresAt, args.now),
      ),
    )
    .returning();
  return row ?? null;
}

// Used after a failed rotation to see whether the presented token is one we already
// rotated away from (a replay), as opposed to one we never issued.
export async function findSessionByPreviousHash(
  executor: DbExecutor,
  hash: string,
): Promise<Session | null> {
  const [row] = await executor
    .select()
    .from(sessions)
    .where(eq(sessions.previousTokenHash, hash))
    .limit(1);
  return row ?? null;
}

export async function revokeSession(executor: DbExecutor, sessionId: string): Promise<void> {
  await executor.update(sessions).set({ revoked: true }).where(eq(sessions.id, sessionId));
}
