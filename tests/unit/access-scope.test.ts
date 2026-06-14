import { describe, it, expect, vi } from "vitest";

// access-scope.server imports `db` (for the membership helpers). The pure
// decision functions under test never touch it; mock it so importing the
// module does not open a real pg pool.
vi.mock("@/db/database", () => ({ db: {} }));

import {
  isSuperadmin,
  resolveOrgScope,
  canAccessOrg,
  SUPERADMIN_PERMISSION,
} from "@/lib/admin/access-scope.server";

/**
 * Unit tests for the three-tier access-control core (ADR-0001). These
 * functions encode the entire authorization decision, so they are tested
 * exhaustively in isolation.
 */
const superadmin = {
  permissions: [SUPERADMIN_PERMISSION, "admin.users.read"],
  organizationId: "org-a",
};
const orgAdmin = {
  permissions: ["admin.users.read", "admin.apikeys.manage"],
  organizationId: "org-a",
};
const orglessAdmin = { permissions: ["admin.users.read"], organizationId: null };

describe("isSuperadmin", () => {
  it("is true only when the superuser marker is held", () => {
    expect(isSuperadmin(superadmin)).toBe(true);
    expect(isSuperadmin(orgAdmin)).toBe(false);
    expect(isSuperadmin({ permissions: [] })).toBe(false);
  });
});

describe("resolveOrgScope", () => {
  it("superadmin → no scoping (all orgs)", () => {
    expect(resolveOrgScope(superadmin)).toEqual({ kind: "all" });
  });
  it("org admin → confined to their single org", () => {
    expect(resolveOrgScope(orgAdmin)).toEqual({ kind: "org", organizationId: "org-a" });
  });
  it("org admin with no active org → null (caller must deny / return empty)", () => {
    expect(resolveOrgScope(orglessAdmin)).toBeNull();
  });
});

describe("canAccessOrg", () => {
  it("superadmin may act on any org, including a null (global) resource", () => {
    expect(canAccessOrg(superadmin, "org-b")).toBe(true);
    expect(canAccessOrg(superadmin, "org-a")).toBe(true);
    expect(canAccessOrg(superadmin, null)).toBe(true);
  });
  it("org admin may act ONLY on an exact match to their own org", () => {
    expect(canAccessOrg(orgAdmin, "org-a")).toBe(true);
    expect(canAccessOrg(orgAdmin, "org-b")).toBe(false);
    // A global/null-org resource is not an org admin's to touch.
    expect(canAccessOrg(orgAdmin, null)).toBe(false);
  });
  it("an admin with no resolvable org can access nothing", () => {
    expect(canAccessOrg(orglessAdmin, "org-a")).toBe(false);
    expect(canAccessOrg(orglessAdmin, null)).toBe(false);
  });
});
