import { config } from "../config.js";
import { logger } from "../logger.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createDb } from "./client.js";
import { seedPermissions } from "./seed-permissions.js";

// Seeds the global permission catalogue. Default roles are NOT seeded here;
// they are copied per organization by provisionDefaultRoles().
async function main() {
  const pool = createPostgresPool(config.postgres);

  try {
    const count = await seedPermissions(createDb(pool));
    logger.info(`Seeded ${count} permissions`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error(err, "Seed failed");
  process.exit(1);
});
