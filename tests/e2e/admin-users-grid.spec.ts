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

/**
 * A11Y-4 — the sort button of a SORTABLE column is named after the column.
 *
 * The real-browser half of the contract (docs/admin-manager.md §7.2). The
 * component test pins it in jsdom; this proves the same accessible-name
 * computation in a real engine, against the real translated headers.
 *
 * It lives here rather than in tests/accessibility because axe cannot see this
 * defect: before the fix every sort button was labelled "— Not sorted", which
 * is a non-empty accessible name, so the WCAG 2.1 AA sweep over this very page
 * stayed green while every column control was unnamed and indistinguishable.
 */
test("sortable column headers are named after their column, not their sort state", async ({
  page,
}) => {
  await page.goto("/en/app/administrator/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

  // `exact` matters: the failure being guarded against is extra text (the sort
  // state) joining — or replacing — the column name.
  const emailHeader = page.getByRole("columnheader", { name: "Email", exact: true });
  await expect(emailHeader).toBeVisible();
  await expect(emailHeader.getByRole("button", { name: "Email", exact: true })).toBeVisible();

  // The sort state rides `aria-sort` and an `aria-describedby` span, neither of
  // which may leak into a name.
  await expect(page.getByRole("table").getByRole("button", { name: /sorted/i })).toHaveCount(0);
});
