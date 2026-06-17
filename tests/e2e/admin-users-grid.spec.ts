import { expect, test } from "@playwright/test";
import { signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the Administrator Users grid renders the new "Organization" column
 * and loads its rows from the real route. Running it as the seed superadmin
 * exercises the org-name correlated subquery against Postgres: a SQL error
 * would 500 the list endpoint and the admin's own row would never appear,
 * failing this test (which the mocked unit tests cannot catch).
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("users grid shows the Organization column and loads rows from the route", async ({ page }) => {
  await page.goto("/en/app/administrator/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

  // The new column header is present.
  await expect(page.getByRole("columnheader", { name: "Organization", exact: true })).toBeVisible();

  // The grid fetched successfully from /api/administrator/users (the seed
  // admin is an app user, so their row renders) — proving the org-name
  // subquery is valid SQL.
  await expect(page.getByText("admin@devresponse.local").first()).toBeVisible();
});
