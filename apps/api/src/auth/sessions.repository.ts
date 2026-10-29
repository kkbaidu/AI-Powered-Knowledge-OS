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
