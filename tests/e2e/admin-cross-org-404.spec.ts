import { expect, test } from "@playwright/test";
import { signInAsSeedAdmin } from "./helpers/admin-auth";
import {
  addActiveMembership,
  assignRole,
  createActiveUser,
  createOrganization,
  deleteMembership,
  deleteOrganization,
  findDefaultOrg,
  findOrgRole,
  signInAs,
  softDeleteUser,
  unassignRole,
  uniqueSuffix,
} from "./helpers/authz-fixtures";

/**
 * E2E — ADR-0001 tenant boundary on the administrator user DETAIL page
 * (review #29): an org admin of org A who asks for
 * `/en/app/administrator/users/<id of a user who exists only in org B>`
 * must get an HTTP 404 that is indistinguishable from a missing id.
 *
 * Two independent assertions, because each catches a different regression:
 *   - `response.status() === 404` — `page.goto` resolves for ANY status, and
 *     an RSC that throws renders a 500 error page that still "loads", so the
 *     status code is the only thing that proves `notFound()` ran (not a
 *     crash, not a 200 with hidden data);
 *   - the localized not-found body — proves the 404 is the app's own page
 *     (no leaked detail fields), and that the same page is what a genuinely
 *     unknown id produces, so existence in another tenant cannot be inferred.
 *
 * The org admin holds the SEEDED `admin` role in the default org
 * (`admin.users.read` + `admin.users.manage`, no `superuser` marker), which is
 * the exact shape whose reads the boundary scopes. As a control, the SAME
 * admin opens a user inside their own org with a 200.
 */
test("an org admin gets 404 for a user who exists only in another org", async ({
  page,
  browser,
}, testInfo) => {
  await signInAsSeedAdmin(page);
  const api = page.request;

  const suffix = uniqueSuffix(testInfo);
  const orgA = await findDefaultOrg(api);
  const adminRoleA = await findOrgRole(api, orgA.id, "admin");
  const orgB = await createOrganization(api, `e2e-xorg-b-${suffix}`);

  const orgAdmin = await createActiveUser(api, {
    email: `e2e.xorg.admin.${suffix}@devresponse.local`,
    password: "E2e-XorgAdmin-123!",
    name: "E2E Org A Admin",
  });
  const orgAdminMembership = await addActiveMembership(api, orgAdmin.id, orgA.id);
  await assignRole(api, orgAdmin.id, adminRoleA.id, orgA.id);

  const foreign = await createActiveUser(api, {
    email: `e2e.xorg.foreign.${suffix}@devresponse.local`,
    password: "E2e-XorgForeign-123!",
    name: "E2E Org B Only",
  });
  const foreignMembership = await addActiveMembership(api, foreign.id, orgB.id);

  const local = await createActiveUser(api, {
    email: `e2e.xorg.local.${suffix}@devresponse.local`,
    password: "E2e-XorgLocal-123!",
    name: "E2E Org A Member",
  });
  const localMembership = await addActiveMembership(api, local.id, orgA.id);

  const context = await browser.newContext();
  try {
    await signInAs(context.request, orgAdmin);
    const adminPage = await context.newPage();

    // Control: a same-org user renders with a 200 and shows their identity,
    // so the 404s below are the tenant boundary and not a broken workspace.
    const ownRes = await adminPage.goto(`/en/app/administrator/users/${local.id}`);
    expect(ownRes?.status()).toBe(200);
    await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText("E2E Org A Member");

    // Foreign-org user: HTTP 404 (not 200, not 500).
    const foreignRes = await adminPage.goto(`/en/app/administrator/users/${foreign.id}`);
    expect(foreignRes?.status()).toBe(404);
    // ...rendered as the app's localized not-found page, with none of the
    // foreign user's details in it.
    await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    const foreignHtml = await adminPage.content();
    expect(foreignHtml).not.toContain(foreign.email);
    expect(foreignHtml).not.toContain("E2E Org B Only");

    // Indistinguishability: a well-formed id that exists nowhere yields the
    // SAME status and page, so a 404 never confirms a user in another tenant.
    const unknownRes = await adminPage.goto(
      "/en/app/administrator/users/00000000-0000-4000-8000-000000000000",
    );
    expect(unknownRes?.status()).toBe(404);
    await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText("Page not found");

    // The JSON detail route enforces the same boundary (the page is not the
    // only reader of a foreign user's row).
    const apiRes = await context.request.get(`/api/administrator/users/${foreign.id}`);
    expect(apiRes.status(), await apiRes.text()).toBe(404);
  } finally {
    await context.close();
    await unassignRole(api, orgAdmin.id, adminRoleA.id, orgA.id);
    await deleteMembership(api, orgAdmin.id, orgAdminMembership);
    await deleteMembership(api, local.id, localMembership);
    await deleteMembership(api, foreign.id, foreignMembership);
    await deleteOrganization(api, orgB.id);
    await softDeleteUser(api, orgAdmin.id);
    await softDeleteUser(api, local.id);
    await softDeleteUser(api, foreign.id);
  }
});
