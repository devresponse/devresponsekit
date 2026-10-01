import { expect, test } from "@playwright/test";
import { SEED_ADMIN } from "./helpers/admin-auth";

/**
 * E2E — the full sign-in round trip through the real form: the seed
 * admin types credentials, submits, and lands inside the secure shell.
 * This is the path every other authenticated suite shortcuts via the
 * API helper, so it gets one real keyboard-driven pass here.
 */
test("seed admin signs in through the form and reaches the dashboard", async ({ page }) => {
  await page.goto("/en/sign-in");

  await page.getByLabel(/email/i).fill(SEED_ADMIN.email);
  await page.getByLabel(/^password/i).fill(SEED_ADMIN.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await expect(page).toHaveURL(/\/en\/app\/dashboard/, { timeout: 15_000 });
  // The secure shell is up: brand bar + primary navigation landmark.
  const brandBar = page.getByRole("banner", { name: /brand/i });
  await expect(brandBar).toBeVisible();

  // NAVK: the app switcher offers the admin the Administration Console, and the
  // brand (the bar's only link; the sheet portals outside it) returns home.
  await page.getByRole("button", { name: /switch application/i }).click();
  await page.getByRole("link", { name: /administration console/i }).click();
  await expect(page).toHaveURL(/\/en\/app\/administrator$/, { timeout: 15_000 });
  await brandBar.getByRole("link").click();
  await expect(page).toHaveURL(/\/en\/app\/dashboard/, { timeout: 15_000 });
});
