import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";
import {
  addActiveMembership,
  assignRole,
  createActiveUser,
  createOrganization,
  createRoleWithPermissions,
  deleteMembership,
  deleteOrganization,
  deleteRole,
  findDefaultOrg,
  signInAs,
  softDeleteUser,
  unassignRole,
  uniqueSuffix,
} from "./helpers/authz-fixtures";

interface Me {
  betterAuthUserId: string;
  appUserId: string;
  organizationId: string | null;
}

/**
 * E2E — impersonation tenant confinement (P0-1, review #29) against the REAL
 * Better Auth admin plugin. The unit/route tests hand-write
 * `getImpersonatorId`, so nothing else proves the live `impersonatedBy`
 * marker actually reaches the two-route contract:
 *
 *   - `POST /api/preferences/active-org` refuses to switch tenant while the
 *     session is an impersonation (403 `forbidden_while_impersonating`);
 *   - the impersonated session keeps reporting the org impersonation
 *     STARTED in (`/api/v1/me.organizationId`);
 *   - `DELETE …/impersonate` hands the admin their own session back.
 *
 * The shape that made P0-1 dangerous is built for real: the target is a plain
 * MEMBER of org A (the seeded default org) and an ADMIN of org B (a tenant
 * created here). Switching into B would let whoever holds the impersonated
 * session wield the target's admin.* permissions in a tenant the escalation
 * guard never evaluated. To prove the 403 is the confinement (and not a
 * missing membership), the same switch is shown to succeed for the target's
 * OWN, non-impersonated session.
 */
test("an impersonated session cannot switch tenant; stopping restores the admin", async ({
  page,
  browser,
}, testInfo) => {
  await signInAsSeedAdmin(page);
  const api = page.request;

  const adminMeRes = await api.get("/api/v1/me");
  expect(adminMeRes.ok(), await adminMeRes.text()).toBe(true);
  const adminMe = (await adminMeRes.json()) as Me;

  const suffix = uniqueSuffix(testInfo);
  const orgA = await findDefaultOrg(api);
  const orgB = await createOrganization(api, `e2e-imp-b-${suffix}`);
  const roleB = await createRoleWithPermissions(api, orgB.id, `e2e-imp-admin-${suffix}`, [
    "shell.view",
    "admin.users.read",
    "admin.users.manage",
  ]);
  const target = await createActiveUser(api, {
    email: `e2e.imp.target.${suffix}@devresponse.local`,
    password: "E2e-ImpTarget-123!",
    name: "E2E Impersonation Target",
  });
  // Org A FIRST: with no `active_org` cookie the access context falls back to
  // the EARLIEST membership, so A is the org impersonation starts in.
  const membershipA = await addActiveMembership(api, target.id, orgA.id);
  const membershipB = await addActiveMembership(api, target.id, orgB.id);
  await assignRole(api, target.id, roleB.id, orgB.id);

  try {
    // --- Start impersonating. The admin's cookie jar now holds the TARGET's
    // session (Better Auth's nextCookies plugin swaps it in-place).
    const start = await api.post(`/api/administrator/users/${target.id}/impersonate`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(start.ok(), await start.text()).toBe(true);

    const impMeRes = await api.get("/api/v1/me");
    expect(impMeRes.ok(), await impMeRes.text()).toBe(true);
    const impMe = (await impMeRes.json()) as Me;
    expect(impMe.betterAuthUserId).toBe(target.betterAuthUserId);
    expect(impMe.organizationId).toBe(orgA.id);

    // --- The pivot: switching the impersonated session into org B must be
    // refused BEFORE the membership check (the target IS an active member of
    // B, so a 404 here would mean the confinement never fired).
    const pivot = await api.post("/api/preferences/active-org", {
      headers: ADMIN_API_HEADERS,
      data: { organizationId: orgB.id },
    });
    expect(pivot.status(), await pivot.text()).toBe(403);
    expect(((await pivot.json()) as { error: string }).error).toBe("forbidden_while_impersonating");

    // Still confined to A afterwards — no cookie was set by the refusal.
    const afterPivotRes = await api.get("/api/v1/me");
    expect(afterPivotRes.ok(), await afterPivotRes.text()).toBe(true);
    const afterPivot = (await afterPivotRes.json()) as Me;
    expect(afterPivot.betterAuthUserId).toBe(target.betterAuthUserId);
    expect(afterPivot.organizationId).toBe(orgA.id);

    // --- Stop: the `[id]` segment is ignored by the route (the impersonated
    // identity comes from the live session), but pass the real one anyway.
    const stop = await api.delete(`/api/administrator/users/${target.id}/impersonate`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(stop.ok(), await stop.text()).toBe(true);

    const restoredRes = await api.get("/api/v1/me");
    expect(restoredRes.ok(), await restoredRes.text()).toBe(true);
    const restored = (await restoredRes.json()) as Me;
    expect(restored.betterAuthUserId).toBe(adminMe.betterAuthUserId);
    expect(restored.appUserId).toBe(adminMe.appUserId);

    // A second stop on the restored (non-impersonation) session is refused:
    // the admin's own session must never be mistaken for an impersonation.
    const stopAgain = await api.delete(`/api/administrator/users/${target.id}/impersonate`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(stopAgain.status(), await stopAgain.text()).toBe(400);

    // --- Control: the SAME switch is legal for the target's own session, so
    // the 403 above was the impersonation confinement and nothing else.
    const ownContext = await browser.newContext();
    try {
      await signInAs(ownContext.request, target);
      const ownSwitch = await ownContext.request.post("/api/preferences/active-org", {
        headers: ADMIN_API_HEADERS,
        data: { organizationId: orgB.id },
      });
      expect(ownSwitch.ok(), await ownSwitch.text()).toBe(true);
      const ownMeRes = await ownContext.request.get("/api/v1/me");
      expect(ownMeRes.ok(), await ownMeRes.text()).toBe(true);
      expect(((await ownMeRes.json()) as Me).organizationId).toBe(orgB.id);
    } finally {
      await ownContext.close();
    }
  } finally {
    // Cleanup runs as the admin — if impersonation was still live the calls
    // below would 404 as the target, so make sure the admin session is back.
    const who = await api.get("/api/v1/me");
    if (who.ok() && ((await who.json()) as Me).betterAuthUserId !== adminMe.betterAuthUserId) {
      await api.delete(`/api/administrator/users/${target.id}/impersonate`, {
        headers: ADMIN_API_HEADERS,
      });
    }
    await unassignRole(api, target.id, roleB.id, orgB.id);
    await deleteMembership(api, target.id, membershipB);
    await deleteMembership(api, target.id, membershipA);
    await deleteRole(api, roleB.id);
    await deleteOrganization(api, orgB.id);
    await softDeleteUser(api, target.id);
  }
});
