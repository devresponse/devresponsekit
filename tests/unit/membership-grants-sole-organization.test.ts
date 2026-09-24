import { describe, expect, it } from "vitest";
import { soleOrganizationId } from "@/lib/admin/membership-grants.server";

/**
 * F-32 — the org a USER-level membership audit row (`admin.user.membership_*`
 * and the refusals written beside it) is filed under.
 *
 * Tenant-facing audit reads show an org admin exactly the rows stamped with
 * their org, and this row's metadata lists every membership id, role id and
 * group id the request touched. A superadmin request can name memberships in
 * several orgs at once, so stamping any ONE of them would show that tenant the
 * others' ids. The rule: the memberships' org when there is exactly one, else a
 * platform row (`null`); each org keeps its own `admin.organization.member_*`
 * row either way. The DB-backed half (the real PATCH and DELETE routes, and
 * what org A can read afterwards) is in
 * tests/db/admin-audit-organization.db.test.ts.
 */
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const m = (organization_id: string) => ({ organization_id });

describe("soleOrganizationId (F-32)", () => {
  it("stamps the org when every membership is in it", () => {
    expect(soleOrganizationId([m(ORG_A)])).toBe(ORG_A);
    // Several memberships (or the same id twice) in ONE org are still that org.
    expect(soleOrganizationId([m(ORG_A), m(ORG_A)])).toBe(ORG_A);
  });

  it("is a platform row when the memberships span several orgs, whatever the order", () => {
    expect(soleOrganizationId([m(ORG_A), m(ORG_B)])).toBeNull();
    expect(soleOrganizationId([m(ORG_B), m(ORG_A)])).toBeNull();
    // The first row's org must not win just because it came first.
    expect(soleOrganizationId([m(ORG_A), m(ORG_A), m(ORG_B)])).toBeNull();
  });

  it("is a platform row when there are no memberships at all", () => {
    // The routes 404 before an empty list reaches an audit write; the helper
    // still must not invent an org for it.
    expect(soleOrganizationId([])).toBeNull();
  });
});
