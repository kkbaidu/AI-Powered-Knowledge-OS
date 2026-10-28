import { describe, it, expect } from "vitest";
import { DEFAULT_ROLES, PERMISSIONS } from "./seed-data.js";

const catalogue = new Set<string>(PERMISSIONS.map((p) => p.name));

describe("seed data invariants", () => {
  it("has unique permission names in resource.action form", () => {
    expect(catalogue.size).toBe(PERMISSIONS.length);
    for (const name of catalogue) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it("only grants permissions that exist in the catalogue", () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLES)) {
      for (const p of perms) expect(catalogue.has(p), `${role} -> ${p}`).toBe(true);
    }
  });

  it("has no duplicate permissions within a role", () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLES)) {
      expect(new Set(perms).size, role).toBe(perms.length);
    }
  });

  it("gives Owner every permission", () => {
    expect(new Set(DEFAULT_ROLES.Owner)).toEqual(catalogue);
  });

  it("keeps Admin one step below Owner (no org deletion or billing)", () => {
    expect(DEFAULT_ROLES.Admin).not.toContain("organization.delete");
    expect(DEFAULT_ROLES.Admin).not.toContain("billing.manage");
    expect(DEFAULT_ROLES.Admin).toHaveLength(DEFAULT_ROLES.Owner!.length - 2);
  });

  it("is strictly decreasing in privilege: Viewer ⊂ Member ⊂ Developer ⊂ Admin", () => {
    const chain = ["Viewer", "Member", "Developer", "Admin"] as const;
    for (let i = 0; i < chain.length - 1; i++) {
      const lower = new Set(DEFAULT_ROLES[chain[i]!]);
      const higher = new Set(DEFAULT_ROLES[chain[i + 1]!]);
      for (const p of lower) expect(higher.has(p), `${chain[i]} -> ${chain[i + 1]}: ${p}`).toBe(true);
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it("never lets non-admin roles manage members, billing or integrations", () => {
    const forbidden = ["member.invite", "member.remove", "member.manage_roles", "billing.manage", "integration.manage"];
    for (const role of ["Developer", "Member", "Viewer"]) {
      for (const p of forbidden) expect(DEFAULT_ROLES[role]).not.toContain(p);
    }
  });
});
