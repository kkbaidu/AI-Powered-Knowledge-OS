import { sql } from "drizzle-orm";
import type { DbExecutor } from "./client.js";
import { permissions } from "./schema/index.js";
import { PERMISSIONS } from "./seed-data.js";

// Upserts the global permission catalogue. Idempotent: re-running updates
// descriptions and never duplicates rows. Returns how many permissions are defined.
export async function seedPermissions(executor: DbExecutor): Promise<number> {
  await executor
    .insert(permissions)
    .values(PERMISSIONS.map((p) => ({ name: p.name, description: p.description })))
    .onConflictDoUpdate({
      target: permissions.name,
      set: { description: sql`excluded.description` },
    });

  return PERMISSIONS.length;
}
