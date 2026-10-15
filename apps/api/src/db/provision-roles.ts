import { and, eq } from "drizzle-orm";
import type { Database } from "./index";
import { permissions, rolePermissions, roles } from "./schema";
import { DEFAULT_ROLES } from "./seed-data";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export async function provisionDefaultRoles(executor: Executor, organizationId: string) {
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

    // on conflict, nothing is returned, so fetch the existing row
    const roleId =
      inserted?.id ??
      (
        await executor
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.organizationId, organizationId), eq(roles.name, roleName)))
      )[0].id;

    const rows = permNames.map((name) => {
      const permissionId = permIdByName.get(name);
      if (!permissionId) throw new Error(`Permission not seeded: ${name}`);
      return { roleId, permissionId };
    });

    if (rows.length) {
      await executor.insert(rolePermissions).values(rows).onConflictDoNothing();
    }
  }
}