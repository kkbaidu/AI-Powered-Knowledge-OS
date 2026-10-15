import "dotenv/config"; // must be first so DATABASE_URL exists before db is imported
import { sql } from "drizzle-orm";
import { db, pool } from "./index";
import { permissions } from "./schema";
import { PERMISSIONS } from "./seed-data";

async function main() {
  await db
    .insert(permissions)
    .values(PERMISSIONS.map((p) => ({ name: p.name, description: p.description })))
    .onConflictDoUpdate({
      target: permissions.name,
      set: { description: sql`excluded.description` }, // keeps descriptions in sync
    });

  console.log(`Seeded ${PERMISSIONS.length} permissions`);
}

main()
  .catch((err) => {
    console.error("Seed failed", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());