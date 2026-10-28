import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { createPostgresPool } from "../infra/postgres.js";
import { createDb } from "./client.js";
import {
  organizationMembers,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  users,
} from "./schema/index.js";
import { seedPermissions } from "./seed-permissions.js";
import { provisionDefaultRoles } from "./provision-roles.js";
import { DEFAULT_ROLES, PERMISSIONS } from "./seed-data.js";
import { assertDatabaseReady, expectPgError, unique } from "../test/integration.js";

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

const pool = createPostgresPool(config.postgres);
const db = createDb(pool);

// Every test creates its own uniquely named rows and we remove them afterwards,
// so tests do not interfere with each other or with a developer's local data.
const createdUserIds: string[] = [];

async function createUser(email = `${unique("user")}@example.com`) {
  const [user] = await db.insert(users).values({ email }).returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function createOrg(ownerId: string) {
  const slug = unique("org");
  const [org] = await db.insert(organizations).values({ name: slug, slug, ownerId }).returning();
  return org!;
}

beforeAll(async () => {
  await assertDatabaseReady(pool);
  await seedPermissions(db);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // organizations.owner_id is RESTRICT, so delete orgs first (this cascades roles and memberships).
    await db.delete(organizations).where(inArray(organizations.ownerId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await pool.end();
});

describe("migrations", () => {
  it("created every identity table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = result.rows.map((r) => r.table_name);
    for (const t of [
      "users",
      "sessions",
      "organizations",
      "roles",
      "permissions",
      "role_permissions",
      "organization_members",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("enabled pgvector and it actually works", async () => {
    const result = await pool.query<{ distance: number }>(
      "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
    );
    expect(result.rows[0]!.distance).toBeCloseTo(1);
  });

  it("uses timestamptz for audit columns", async () => {
    const result = await pool.query<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('created_at','updated_at')",
    );
    expect(result.rows.map((r) => r.data_type)).toEqual([
      "timestamp with time zone",
      "timestamp with time zone",
    ]);
  });
});

describe("users", () => {
  it("rejects an email that differs only by case", async () => {
    const email = `${unique("case")}@Example.com`;
    await createUser(email);

    const code = await expectPgError(() => db.insert(users).values({ email: email.toLowerCase() }));

    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("finds a user by lower(email) regardless of the stored casing", async () => {
    const user = await createUser(`${unique("find")}@Example.COM`);

    const [found] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${user.email.toLowerCase()}`);

    expect(found?.id).toBe(user.id);
  });

  it("defaults new users to pending_verification with UUID ids", async () => {
    const user = await createUser();
    expect(user.status).toBe("pending_verification");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refreshes updated_at when updated through Drizzle", async () => {
    const user = await createUser();
    await new Promise((r) => setTimeout(r, 15));

    const [updated] = await db
      .update(users)
      .set({ displayName: "Renamed" })
      .where(eq(users.id, user.id))
      .returning();

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });
});

describe("sessions", () => {
  it("enforces unique refresh token hashes", async () => {
    const user = await createUser();
    const hash = unique("hash");
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(sessions).values({ userId: user.id, refreshTokenHash: hash, expiresAt });

    const code = await expectPgError(() =>
      db.insert(sessions).values({ userId: user.id, refreshTokenHash: hash, expiresAt }),
    );

    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("is deleted together with its user (CASCADE)", async () => {
    const user = await createUser();
    await db.insert(sessions).values({
      userId: user.id,
      refreshTokenHash: unique("hash"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await db.delete(users).where(eq(users.id, user.id));

    const left = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(left).toHaveLength(0);
  });
});

describe("organizations and membership", () => {
  it("refuses to delete a user who still owns an organization (RESTRICT)", async () => {
    const owner = await createUser();
    await createOrg(owner.id);

    const code = await expectPgError(() => db.delete(users).where(eq(users.id, owner.id)));

    expect(code).toBe(FK_VIOLATION);
  });

  it("allows a user to be a member of an organization only once", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);
    await provisionDefaultRoles(db, org.id);
    const [memberRole] = await db.select().from(roles).where(eq(roles.organizationId, org.id));
    await db
      .insert(organizationMembers)
      .values({ organizationId: org.id, userId: owner.id, roleId: memberRole!.id });

    const code = await expectPgError(() =>
      db.insert(organizationMembers).values({ organizationId: org.id, userId: owner.id, roleId: memberRole!.id }),
    );

    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("refuses to delete a role that members still hold (RESTRICT)", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);
    await provisionDefaultRoles(db, org.id);
    const [role] = await db.select().from(roles).where(eq(roles.organizationId, org.id));
    await db
      .insert(organizationMembers)
      .values({ organizationId: org.id, userId: owner.id, roleId: role!.id });

    const code = await expectPgError(() => db.delete(roles).where(eq(roles.id, role!.id)));

    expect(code).toBe(FK_VIOLATION);
  });

  it("deleting an organization removes its roles, role permissions and memberships (CASCADE)", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);
    await provisionDefaultRoles(db, org.id);
    const [role] = await db.select().from(roles).where(eq(roles.organizationId, org.id));
    await db
      .insert(organizationMembers)
      .values({ organizationId: org.id, userId: owner.id, roleId: role!.id });
    const roleIds = (await db.select({ id: roles.id }).from(roles).where(eq(roles.organizationId, org.id))).map(
      (r) => r.id,
    );

    await db.delete(organizations).where(eq(organizations.id, org.id));

    expect(await db.select().from(roles).where(eq(roles.organizationId, org.id))).toHaveLength(0);
    expect(await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))).toHaveLength(0);
    expect(
      await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, org.id)),
    ).toHaveLength(0);
  });

  it("enforces unique organization slugs", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);

    const code = await expectPgError(() =>
      db.insert(organizations).values({ name: "dup", slug: org.slug, ownerId: owner.id }),
    );

    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe("seedPermissions", () => {
  it("is idempotent: running again keeps the same rows and ids", async () => {
    const before = await db.select().from(permissions);

    await seedPermissions(db);
    await seedPermissions(db);

    const after = await db.select().from(permissions);
    expect(after).toHaveLength(PERMISSIONS.length);
    expect(new Set(after.map((p) => p.id))).toEqual(new Set(before.map((p) => p.id)));
  });

  it("restores a drifted description", async () => {
    await db.update(permissions).set({ description: "tampered" }).where(eq(permissions.name, "document.read"));

    await seedPermissions(db);

    const [row] = await db.select().from(permissions).where(eq(permissions.name, "document.read"));
    expect(row!.description).toBe("Read documents");
  });
});

describe("provisionDefaultRoles", () => {
  async function permissionNamesByRole(organizationId: string) {
    const rows = await db
      .select({ role: roles.name, permission: permissions.name })
      .from(roles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(roles.organizationId, organizationId));

    const byRole: Record<string, string[]> = {};
    for (const row of rows) (byRole[row.role] ??= []).push(row.permission);
    return byRole;
  }

  it("creates each default role with exactly the permissions in the matrix", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);

    await provisionDefaultRoles(db, org.id);

    const byRole = await permissionNamesByRole(org.id);
    expect(Object.keys(byRole).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
    for (const [role, expected] of Object.entries(DEFAULT_ROLES)) {
      expect([...byRole[role]!].sort(), role).toEqual([...expected].sort());
    }
  });

  it("is idempotent, including when run inside a transaction", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);

    await provisionDefaultRoles(db, org.id);
    const first = await permissionNamesByRole(org.id);
    await provisionDefaultRoles(db, org.id);
    await db.transaction((tx) => provisionDefaultRoles(tx, org.id));

    expect(await permissionNamesByRole(org.id)).toEqual(first);
    expect(await db.select().from(roles).where(eq(roles.organizationId, org.id))).toHaveLength(
      Object.keys(DEFAULT_ROLES).length,
    );
  });

  it("rolls back completely if the surrounding transaction fails", async () => {
    const owner = await createUser();
    const org = await createOrg(owner.id);

    await expect(
      db.transaction(async (tx) => {
        await provisionDefaultRoles(tx, org.id);
        throw new Error("simulated failure after provisioning");
      }),
    ).rejects.toThrow("simulated failure");

    expect(await db.select().from(roles).where(eq(roles.organizationId, org.id))).toHaveLength(0);
  });

  it("keeps organizations isolated: roles are per organization", async () => {
    const owner = await createUser();
    const a = await createOrg(owner.id);
    const b = await createOrg(owner.id);

    await provisionDefaultRoles(db, a.id);
    await provisionDefaultRoles(db, b.id);

    const rolesA = await db.select({ id: roles.id }).from(roles).where(eq(roles.organizationId, a.id));
    const rolesB = await db.select({ id: roles.id }).from(roles).where(eq(roles.organizationId, b.id));
    const idsA = new Set(rolesA.map((r) => r.id));
    expect(rolesB.some((r) => idsA.has(r.id))).toBe(false);
  });
});
