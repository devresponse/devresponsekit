import { expect, test } from "@playwright/test";

/**
 * E2E §29.8.9 — switching locales via the locale switcher must rewrite
 * `/en/...` to `/fr/...` while preserving the rest of the path.
 */
test("locale switcher changes /en/sign-in to /fr/sign-in", async ({ page }) => {
  await page.goto("/en/sign-in");

  // The locale switcher renders as a combobox labelled "Language".
  await page.getByRole("combobox", { name: /language/i }).click();
  await page.getByRole("option", { name: /français/i }).click();

  await expect(page).toHaveURL(/\/fr\/sign-in/);
});
