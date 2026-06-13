import { expect, test, type Page } from "@playwright/test";
import { signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the FlexSidebar icon collapse contract on the secure shell:
 * fixed column widths (16rem expanded / 3rem collapsed), zero layout
 * shift across navigation in either state, and cookie persistence
 * across a reload. This is exactly the regression class that was
 * caught manually during development (stuck mid-transition columns).
 *
 * Desktop-only: the mobile project renders the sidebar as a sheet.
 */
async function leftColumnWidth(page: Page): Promise<number> {
  return Math.round(
    await page
      .locator(".sh-left")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width),
  );
}

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only: mobile uses the sheet drawer");
  await signInAsSeedAdmin(page);
});

test("collapse is fixed-width, survives navigation, and persists across reload", async ({
  page,
}) => {
  await page.goto("/en/app/dashboard");
  await expect(page.locator(".sh-left").first()).toBeVisible();
  expect(await leftColumnWidth(page)).toBe(256);

  // Collapse via the root trigger (brand bar).
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect.poll(() => leftColumnWidth(page)).toBe(48);

  // Navigate while collapsed — the column must not move.
  await page.locator('.sh-left a[href*="/app/workspace"]').click();
  await expect(page).toHaveURL(/\/en\/app\/workspace/);
  expect(await leftColumnWidth(page)).toBe(48);

  // The provider persists state in a cookie — survive a full reload.
  await page.reload();
  await expect(page.locator(".sh-left").first()).toBeVisible();
  expect(await leftColumnWidth(page)).toBe(48);

  // Expand again and navigate — still no shift.
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect.poll(() => leftColumnWidth(page)).toBe(256);
  await page.locator('.sh-left a[href*="/app/dashboard"]').click();
  await expect(page).toHaveURL(/\/en\/app\/dashboard/);
  expect(await leftColumnWidth(page)).toBe(256);
});
