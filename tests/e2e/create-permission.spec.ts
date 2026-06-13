import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the create-permission round trip through the standard
 * new-record page: fill the form, submit, land back on the catalog,
 * and confirm the key exists. The created row is deleted through the
 * admin API afterwards so repeated runs (and local dev databases)
 * stay clean.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("creates a permission via the new-record page and cleans up", async ({ page }, testInfo) => {
  // Unique per run AND per project (chromium/mobile run sequentially
  // against the same database).
  const key = `e2e.perm.${testInfo.project.name}.${Date.now()}`;

  await page.goto("/en/app/administrator/permissions/new");
  await expect(page.getByRole("heading", { name: "Create permission" })).toBeVisible();

  await page.getByLabel("Key").fill(key);
  await page.getByLabel("Description").fill("Created by the e2e suite");
  await page.getByRole("button", { name: "Create permission" }).click();

  // Success navigates back to the catalog.
  await expect(page).toHaveURL(/\/en\/app\/administrator\/permissions(?:\?|$)/, {
    timeout: 15_000,
  });

  // The row exists end-to-end (created via the UI, read via the API).
  const list = await page.request.get(
    `/api/administrator/permissions?q=${encodeURIComponent(key)}`,
  );
  expect(list.ok()).toBe(true);
  const body = (await list.json()) as { items: { id: string; key: string }[] };
  const created = body.items.find((i) => i.key === key);
  expect(created, `permission ${key} should exist after create`).toBeDefined();

  // Cleanup.
  const del = await page.request.delete(`/api/administrator/permissions/${created!.id}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(del.ok(), await del.text()).toBe(true);
});
