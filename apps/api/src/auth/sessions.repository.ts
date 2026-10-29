import { and, eq, gt, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";

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

// Logout. Matches the CURRENT or the PREVIOUS token, so a logout that races a refresh
// (sent with the cookie from just before the rotation) still ends the session instead of
// silently doing nothing. Returns the session id if one was revoked, null otherwise.
// Already-revoked sessions are skipped so repeating a logout is a harmless no-op.
export async function revokeSessionByTokenHash(
  executor: DbExecutor,
  tokenHash: string,
): Promise<string | null> {
  const [row] = await executor
    .update(sessions)
    .set({ revoked: true })
    .where(
      and(
        or(
          eq(sessions.refreshTokenHash, tokenHash),
          eq(sessions.previousTokenHash, tokenHash),
        ),
        eq(sessions.revoked, false),
      ),
    )
    .returning({ id: sessions.id });
  return row?.id ?? null;
}

export interface SessionForAuth {
  userId: string;
  revoked: boolean;
  expiresAt: Date;
  userStatus: (typeof users.$inferSelect)["status"];
}

// One indexed lookup (sessions PK, users PK) used by requireAuth when a route wants
// instant revocation instead of trusting the JWT alone.
export async function findSessionForAuth(
  executor: DbExecutor,
  sessionId: string,
): Promise<SessionForAuth | null> {
  const [row] = await executor
    .select({
      userId: sessions.userId,
      revoked: sessions.revoked,
      expiresAt: sessions.expiresAt,
      userStatus: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

// "Log out everywhere": one statement ends every live session of the user (uses
// sessions_user_id_idx). Returns how many were ended.
export async function revokeAllUserSessions(
  executor: DbExecutor,
  userId: string,
): Promise<number> {
  const rows = await executor
    .update(sessions)
    .set({ revoked: true })
    .where(and(eq(sessions.userId, userId), eq(sessions.revoked, false)))
    .returning({ id: sessions.id });
  return rows.length;
}
