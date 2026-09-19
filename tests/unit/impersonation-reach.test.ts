import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReachModule from "@/lib/impersonation-reach.server";

/**
 * IMP-2 — `listImpersonationReachableOrgIds`, the single definition of how far
 * an impersonated session may reach.
 *
 * IMP-1 measured the impersonator's tenancy with `app_organization_memberships`
 * rows. For every principal except one, membership IS reach — but the exception
 * is the principal impersonation exists for. A global superuser's reach is
 * conferred by permission (`hasCrossOrgReach`, `canAccessUser` returns true for
 * ANY user), and creating an organization never enrols the creator, so
 * "superadmin supports a customer tenant they do not belong to" is the normal
 * case, not the edge one. Measured by membership it produced an intersection of
 * `[]`, i.e. a borrowed session that resolved no org, no permissions and not
 * even `shell.view` — a dead session on a page outside the secure layout, with
 * neither a Stop control nor a sign-out button on it.
 *
 * `null` means UNCONFINED and is a different answer from `[]`, which means
 * "resolve nothing". Confusing the two in either direction is the whole bug:
 * `[]` read as unconfined would hand a suspended admin's borrowed session the
 * run of the platform, and `null` read as empty is the dead session above.
 */

const betterAuthUserIsGlobalSuperuser = vi.fn();
const listActiveOrganizationIdsForBetterAuthUser = vi.fn();

vi.mock("@/lib/admin/access-scope.server", () => ({
  betterAuthUserIsGlobalSuperuser: (...a: unknown[]) => betterAuthUserIsGlobalSuperuser(...a),
}));
vi.mock("@/lib/active-org.server", () => ({
  listActiveOrganizationIdsForBetterAuthUser: (...a: unknown[]) =>
    listActiveOrganizationIdsForBetterAuthUser(...a),
}));

let mod: typeof ReachModule;

beforeEach(async () => {
  betterAuthUserIsGlobalSuperuser.mockReset();
  listActiveOrganizationIdsForBetterAuthUser.mockReset();
  mod = await import("@/lib/impersonation-reach.server");
});
afterEach(() => vi.resetModules());

describe("listImpersonationReachableOrgIds", () => {
  it("returns null (UNCONFINED) for a global superuser, without listing memberships", async () => {
    betterAuthUserIsGlobalSuperuser.mockResolvedValue(true);

    await expect(mod.listImpersonationReachableOrgIds("ba-super")).resolves.toBeNull();

    expect(betterAuthUserIsGlobalSuperuser).toHaveBeenCalledWith("ba-super");
    // Not merely unused — not even fetched, so a membership list that happens
    // to be empty can never be mistaken for the answer.
    expect(listActiveOrganizationIdsForBetterAuthUser).not.toHaveBeenCalled();
  });

  it("returns the impersonator's active organizations for everyone else", async () => {
    betterAuthUserIsGlobalSuperuser.mockResolvedValue(false);
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue(["o-a", "o-b"]);

    await expect(mod.listImpersonationReachableOrgIds("ba-admin")).resolves.toEqual(["o-a", "o-b"]);

    expect(listActiveOrganizationIdsForBetterAuthUser).toHaveBeenCalledWith("ba-admin");
  });

  it("returns [] — NOT null — for a non-superadmin who belongs nowhere (fail closed)", async () => {
    // The distinction the caller's fail-closed branch turns on.
    betterAuthUserIsGlobalSuperuser.mockResolvedValue(false);
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue([]);

    const reach = await mod.listImpersonationReachableOrgIds("ba-nobody");

    expect(reach).toEqual([]);
    expect(reach).not.toBeNull();
  });
});
