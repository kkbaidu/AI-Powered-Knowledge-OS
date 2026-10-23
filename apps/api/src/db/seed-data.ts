export const PERMISSIONS = [
  { name: "organization.update", description: "Edit organization settings" },
  { name: "organization.delete", description: "Delete the organization" },
  { name: "billing.manage", description: "Manage billing" },
  { name: "member.invite", description: "Invite members" },
  { name: "member.remove", description: "Remove members" },
  { name: "member.manage_roles", description: "Change member roles" },
  { name: "workspace.read", description: "View workspaces" },
  { name: "workspace.create", description: "Create workspaces" },
  { name: "workspace.manage", description: "Edit or archive workspaces" },
  { name: "document.read", description: "Read documents" },
  { name: "document.create", description: "Upload or create documents" },
  { name: "document.update", description: "Edit documents" },
  { name: "document.delete", description: "Delete documents" },
  { name: "ai.chat", description: "Use AI chat" },
  { name: "agent.create", description: "Create agents" },
  { name: "agent.execute", description: "Run agents" },
  { name: "integration.manage", description: "Manage integrations" },
] as const;

export type PermissionName = (typeof PERMISSIONS)[number]["name"];

const ALL: readonly PermissionName[] = PERMISSIONS.map((p) => p.name);
const OWNER_ONLY: readonly PermissionName[] = ["organization.delete", "billing.manage"];

// Role -> permission matrix. Copied into each organization at creation.
export const DEFAULT_ROLES: Record<string, readonly PermissionName[]> = {
  Owner: ALL,
  Admin: ALL.filter((p) => !OWNER_ONLY.includes(p)),
  Developer: [
    "workspace.read",
    "document.read",
    "document.create",
    "document.update",
    "ai.chat",
    "agent.create",
    "agent.execute",
  ],
  Member: ["workspace.read", "document.read", "ai.chat"],
  Viewer: ["workspace.read", "document.read"],
};
