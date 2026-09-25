import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_MEDIA_QUERY, MOBILE_MEDIA_QUERY } from "../../src/lib/breakpoints";
import { signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — primary navigation is reachable on both sides of the `md` breakpoint
 * (F-36).
 *
 * At exactly 768px (iPad portrait, or a 1536px laptop at 200% zoom)
 * app-shell.css hid the sidebar while `useIsMobile` still chose the desktop
 * rail, so the trigger only collapsed a rail nobody could see and the
 * navigation could not be reached. The projects in playwright.config.ts run
 * at 412px and 1280px, far from the boundary, so neither saw it.
 *
 * The component and unit tests prove the queries agree; this proves a real
 * browser evaluates the shared range-syntax query the way they assume, and
 * that the shell is usable at 768px and at 767px.
 *
 * Desktop project only: each case sets its own viewport, so the Pixel 7
 * project would only repeat it with touch emulation on.
 */
const WORKSPACE_LINK = 'a[href*="/app/workspace"]';
const PROFILE_LINK = 'a[href$="/app/account/profile"]';

async function openAt(page: Page, width: number, path = "/en/app/dashboard"): Promise<void> {
  await page.setViewportSize({ width, height: 1024 });
  await page.goto(path);
  expect(page.url(), `expected the secure shell, got ${page.url()}`).not.toContain("/sign-in");
  // `useIsMobile` reads the real matchMedia after hydration; wait for it so
  // the trigger is wired to the branch the width calls for.
  await page.waitForLoadState("networkidle");
}

/** The browser's own answer to the two shared queries. */
function sharedQueries(page: Page): Promise<{ mobile: boolean; desktop: boolean }> {
  return page.evaluate(
    ([mobile, desktop]) => ({
      mobile: window.matchMedia(mobile).matches,
      desktop: window.matchMedia(desktop).matches,
    }),
    [MOBILE_MEDIA_QUERY, DESKTOP_MEDIA_QUERY] as const,
  );
}

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, "sets its own viewport; the desktop project covers it");
  await signInAsSeedAdmin(page);
});

test("768×1024: the sidebar is in the layout and its links work", async ({ page }) => {
  await openAt(page, 768);
  // A browser that could not parse the range syntax would answer false to
  // BOTH; exactly one must match.
  expect(await sharedQueries(page)).toEqual({ mobile: false, desktop: true });

  const rail = page.locator("#navigation");
  await expect(rail).toBeVisible();
  const link = rail.locator(WORKSPACE_LINK);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/en\/app\/workspace/);
});

test("767×1024: the rail is hidden and the trigger opens the navigation drawer", async ({
  page,
}) => {
  await openAt(page, 767);
  expect(await sharedQueries(page)).toEqual({ mobile: true, desktop: false });

  await expect(page.locator("#navigation")).toBeHidden();
  const drawer = page.getByRole("dialog");
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(drawer).toBeVisible();
  const link = drawer.locator(WORKSPACE_LINK);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/en\/app\/workspace/);
});

// The nested workspace rails (Account here; Administrator, Docs and Help use
// the same FlexSidebar + ApplicationShell pattern) have their own provider,
// their own trigger in the nested header and their own `.sh-left`, so they
// failed at 768px the same way.
test("768×1024: the nested Account rail is in the layout", async ({ page }) => {
  await openAt(page, 768, "/en/app/account");
  const rail = page.locator("#navigation-1");
  await expect(rail).toBeVisible();
  await rail.locator(PROFILE_LINK).click();
  await expect(page).toHaveURL(/\/en\/app\/account\/profile/);
});

test("767×1024: the nested Account trigger opens its own drawer", async ({ page }) => {
  await openAt(page, 767, "/en/app/account");
  await expect(page.locator("#navigation-1")).toBeHidden();
  // The nested header's trigger sits inside the root <main>; the root one is
  // in the brand bar above it.
  await page.locator('#main [data-sidebar="trigger"]').click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await drawer.locator(PROFILE_LINK).click();
  await expect(page).toHaveURL(/\/en\/app\/account\/profile/);
});
