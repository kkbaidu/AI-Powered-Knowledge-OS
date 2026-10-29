import { eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../db/client.js";
import { users } from "../db/schema/index.js";

export type User = typeof users.$inferSelect;
export type NewUser = Pick<typeof users.$inferInsert, "email" | "passwordHash" | "displayName" | "status">;

// Single atomic statement: insert, or do nothing if the email is taken. Returns null
// for a duplicate. We do NOT "SELECT then INSERT": two simultaneous registrations
// could both see "free" and one would crash on the unique index. Letting the database
// arbitrate removes that race. (With no conflict target, DO NOTHING covers any unique
// violation; `users` has only the lower(email) one besides the random-UUID primary key.)
export async function insertUserIfEmailFree(
  executor: DbExecutor,
  values: NewUser,
): Promise<User | null> {
  const [row] = await executor.insert(users).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

// Must compare lower(email) so the query can use the unique expression index
// (users_email_lower_uq); a plain `email = $1` cannot. Callers pass an already
// lowercased email (the Zod schema does that), and lowering both sides keeps this
// correct even if a caller forgets.
export async function findUserByEmail(executor: DbExecutor, email: string): Promise<User | null> {
  const [row] = await executor
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

export async function updatePasswordHash(
  executor: DbExecutor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await executor.update(users).set({ passwordHash }).where(eq(users.id, userId));
}
