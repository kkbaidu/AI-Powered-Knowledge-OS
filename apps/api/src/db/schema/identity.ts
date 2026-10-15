import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  inet,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// timestamptz everywhere: stored as UTC instants, rendered per client timezone
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()), // ORM-level only: raw SQL updates bypass it
};

export const userStatus = pgEnum("user_status", [
  "pending_verification",
  "active",
  "suspended",
]);

export const memberStatus = pgEnum("member_status", ["active", "suspended"]);

/* ───────────── users ───────────── */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // nullable: OAuth-only users have no password
    passwordHash: text("password_hash"),
    displayName: text("display_name"),
    status: userStatus("status").notNull().default("pending_verification"),
    ...timestamps,
  },
  (t) => [
    // case-insensitive uniqueness: A@x.com and a@x.com are the same account
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
  ],
);

/* ───────────── sessions ───────────── */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // CASCADE: a session has no meaning without its user
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // we store SHA-256 hashes, never the raw refresh token
    refreshTokenHash: text("refresh_token_hash").notNull(),
    // the hash before the last rotation, used for reuse detection
    previousTokenHash: text("previous_token_hash"),
    deviceInfo: text("device_info"),
    ipAddress: inet("ip_address"),
    revoked: boolean("revoked").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // the hot path: POST /auth/refresh looks up by hash
    uniqueIndex("sessions_refresh_token_hash_uq").on(t.refreshTokenHash),
    // reuse detection looks up by the previous hash
    index("sessions_previous_token_hash_idx").on(t.previousTokenHash),
    // "list/revoke all my sessions", and FK cascade performance
    index("sessions_user_id_idx").on(t.userId),
    // cleanup job: delete expired sessions
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

/* ───────────── organizations ───────────── */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // RESTRICT: you cannot delete a user who owns an org.
    // Ownership must be transferred first (a conscious act).
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    index("organizations_owner_id_idx").on(t.ownerId),
  ],
);

/* ───────────── permissions (global catalogue) ───────────── */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // resource.action, e.g. document.read
    description: text("description"),
  },
  (t) => [uniqueIndex("permissions_name_uq").on(t.name)],
);

/* ───────────── roles (per organization) ───────────── */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // true for the defaults copied in at org creation
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("roles_org_name_uq").on(t.organizationId, t.name)],
);

/* ───────────── role_permissions (many-to-many) ───────────── */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    // PK covers lookups by role; this covers "which roles have permission X"
    index("role_permissions_permission_id_idx").on(t.permissionId),
  ],
);

/* ───────────── organization_members ───────────── */
export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // RESTRICT: you cannot delete a role while members still hold it
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    status: memberStatus("status").notNull().default("active"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    // a user can be a member of an org only once
    uniqueIndex("org_members_org_user_uq").on(t.organizationId, t.userId),
    // "which orgs does this user belong to" (the unique index leads with org)
    index("org_members_user_id_idx").on(t.userId),
    index("org_members_role_id_idx").on(t.roleId),
  ],
);