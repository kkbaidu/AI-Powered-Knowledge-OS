import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "./client.js";
import { permissions, rolePermissions, roles } from "./schema/index.js";
import { DEFAULT_ROLES } from "./seed-data.js";

// Copies the default roles (and their permissions) into one organization.
// Call it inside the same transaction that creates the organization.
// Idempotent: safe to call twice for the same organization.
export async function provisionDefaultRoles(
  executor: DbExecutor,
  organizationId: string,
): Promise<void> {
  const perms = await executor
    .select({ id: permissions.id, name: permissions.name })
    .from(permissions);
  const permIdByName = new Map(perms.map((p) => [p.name, p.id]));

  for (const [roleName, permNames] of Object.entries(DEFAULT_ROLES)) {
    const [inserted] = await executor
      .insert(roles)
      .values({ organizationId, name: roleName, isDefault: true })
      .onConflictDoNothing()
      .returning({ id: roles.id });

    // On conflict nothing is returned, so fetch the existing row.
    let roleId = inserted?.id;
    if (!roleId) {
      const [existing] = await executor
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.organizationId, organizationId), eq(roles.name, roleName)));
      if (!existing) throw new Error(`Role ${roleName} missing after upsert`);
      roleId = existing.id;
    }

    const rows = permNames.map((name) => {
      const permissionId = permIdByName.get(name);
      if (!permissionId) throw new Error(`Permission not seeded: ${name}`);
      return { roleId: roleId as string, permissionId };
    });

    if (rows.length > 0) {
      await executor.insert(rolePermissions).values(rows).onConflictDoNothing();
    }
  }
}
