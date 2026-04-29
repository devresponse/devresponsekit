import { expect, test } from "@playwright/test";

/**
 * E2E §29.8.1 — anonymous visitors hitting a localized secure route
 * must be redirected to the localized sign-in page with a `returnTo`
 * query parameter pointing at the original URL.
 *
 * This spec exercises the proxy-level guard in `src/proxy.ts`. It does
 * not require a live database — only the dev server.
 */
test("anonymous /en/app/dashboard redirects to /en/sign-in?returnTo=...", async ({ page }) => {
  const response = await page.goto("/en/app/dashboard");
  await expect(page).toHaveURL(/\/en\/sign-in\?returnTo=%2Fen%2Fapp%2Fdashboard/);
  // 200 because Next renders the sign-in page after the redirect; the
  // important assertion is the URL.
  expect(response?.status()).toBeLessThan(400);
});

test("sign-in page renders email/password and all three social buttons (§29.8.2)", async ({
  page,
}) => {
  await page.goto("/en/sign-in");
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with microsoft/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
});
