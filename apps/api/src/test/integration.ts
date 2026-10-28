import type { Pool } from "pg";

// Postgres error code, whether Drizzle wrapped the driver error or not.
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

// Run an operation that must fail, and return its Postgres error code.
export async function expectPgError(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
  } catch (err) {
    return pgCode(err);
  }
  throw new Error("Expected the database to reject this operation, but it succeeded");
}

// Fail with an actionable message instead of a confusing connection or "relation does not exist" error.
export async function assertDatabaseReady(pool: Pool): Promise<void> {
  try {
    await pool.query("SELECT 1 FROM users LIMIT 1");
  } catch (err) {
    throw new Error(
      "Integration tests need a running, migrated Postgres. Run: " +
        "docker compose up -d postgres redis && pnpm --filter @atlas/api db:migrate\n" +
        `Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
