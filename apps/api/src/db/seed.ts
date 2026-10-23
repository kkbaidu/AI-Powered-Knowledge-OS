import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createDb } from "./client.js";
import { permissions } from "./schema/index.js";
import { PERMISSIONS } from "./seed-data.js";

// Seeds the global permission catalogue. Idempotent: re-running updates
// descriptions and never duplicates rows. Default roles are NOT seeded here;
// they are copied per organization by provisionDefaultRoles().
async function main() {
  const pool = createPostgresPool(config.postgres);
  const db = createDb(pool);

  try {
    await db
      .insert(permissions)
      .values(PERMISSIONS.map((p) => ({ name: p.name, description: p.description })))
      .onConflictDoUpdate({
        target: permissions.name,
        set: { description: sql`excluded.description` },
      });

    logger.info(`Seeded ${PERMISSIONS.length} permissions`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error(err, "Seed failed");
  process.exit(1);
});
