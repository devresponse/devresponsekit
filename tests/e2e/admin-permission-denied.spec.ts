import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — 404 indistinguishability (docs/admin-manager.md §6.2): an
 * ACTIVE user without any admin.* permission must receive a 404 from
 * the administrator workspace — the route must look like it does not
 * exist — while the regular secure shell stays fully accessible.
 *
 * The non-admin account is created through the real admin API by the
 * seeded admin, exercised in a separate browser context, and
 * soft-deleted afterwards so repeated runs stay clean.
 */
test("an active non-admin gets 404 on /app/administrator", async ({ page, browser }, testInfo) => {
  await signInAsSeedAdmin(page);

  const email = `e2e.nonadmin.${testInfo.project.name}.${Date.now()}@devresponse.local`;
  const password = "E2e-NonAdmin-123!";

  const create = await page.request.post("/api/administrator/users", {
    headers: ADMIN_API_HEADERS,
    data: {
      email,
      password,
      name: "E2E NonAdmin",
      role: "user",
      initialAppStatus: "active",
      preferredLocale: "en",
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  const { id } = (await create.json()) as { id: string };

  // Secure access requires an ACTIVE membership as well as an active
  // user — attach the seeded default organization.
  const orgs = await page.request.get("/api/administrator/organizations?q=default");
  expect(orgs.ok()).toBe(true);
  const orgBody = (await orgs.json()) as { items: { id: string; slug: string }[] };
  const defaultOrg = orgBody.items.find((o) => o.slug === "default");
  expect(defaultOrg, "seeded default organization should exist").toBeDefined();

  const membership = await page.request.post(`/api/administrator/users/${id}/memberships`, {
    headers: ADMIN_API_HEADERS,
    data: { organizationId: defaultOrg!.id, status: "active" },
  });
  expect(membership.ok(), await membership.text()).toBe(true);

  // Fresh context: the non-admin's own session, no admin cookies.
  const context = await browser.newContext();
  try {
    const userPage = await context.newPage();
    const signIn = await userPage.request.post("/api/auth/sign-in/email", {
      data: { email, password },
    });
    expect(signIn.ok()).toBe(true);

    // The secure shell works for an active member...
    await userPage.goto("/en/app/dashboard");
    await expect(userPage).toHaveURL(/\/en\/app\/dashboard/);

    // ...but the administrator workspace is a 404, not a 403.
    const res = await userPage.goto("/en/app/administrator");
    expect(res?.status()).toBe(404);
  } finally {
    await context.close();
  }

  // Cleanup: soft-delete through the admin API.
  const del = await page.request.delete(`/api/administrator/users/${id}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(del.ok(), await del.text()).toBe(true);
});
