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

/**
 * The signed-out SSO launch continuation.
 *
 * A satellite's application switcher links at this deployment's launch
 * endpoint, because a consumer holds no signing key. When the visitor has no
 * session here the redirect must carry a return target, or they sign in and
 * land on the dashboard instead of the application they clicked. The target is
 * a localized PAGE — the return-target sanitizer refuses `/api/` values — and
 * these two specs are the only end-to-end proof of that page, which is excluded
 * from unit coverage as a `page.tsx`.
 */
test("anonymous /api/sso/launch redirects to sign-in carrying the launch return target", async ({
  page,
}) => {
  const response = await page.goto("/api/sso/launch?applicationId=portal&locale=en");
  await expect(page).toHaveURL(
    /\/en\/sign-in\?returnTo=%2Fen%2Fsso%2Flaunch%3FapplicationId%3Dportal%26locale%3Den/,
  );
  // Explicitly asserted: `goto` resolves for an error status too, so a 4xx/5xx
  // would otherwise pass unnoticed.
  expect(response?.status()).toBeLessThan(400);
});

test("anonymous /en/sso/launch settles at sign-in instead of looping", async ({ page }) => {
  // page -> /api/sso/launch -> sign-in. The trampoline reads no session on
  // purpose, so this bounce is the deep-link path working as intended; what it
  // must never do is ping-pong.
  const response = await page.goto("/en/sso/launch?applicationId=portal&locale=en");
  await expect(page).toHaveURL(/\/en\/sign-in/);
  expect(response?.status()).toBeLessThan(400);
});

test("anonymous /en/sso/launch with no applicationId degrades to the dashboard route", async ({
  page,
}) => {
  // A hand-crafted URL on a public path must not raise; it falls through to the
  // dashboard, which for an anonymous visitor means the usual sign-in bounce.
  const response = await page.goto("/en/sso/launch");
  await expect(page).toHaveURL(/\/en\/sign-in\?returnTo=%2Fen%2Fapp%2Fdashboard/);
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

test("organization-scoped sign-in brands the screen and keeps social login (§14.1)", async ({
  page,
}) => {
  // The seed creates the `default` organization ("Default Organization"); the
  // scoped screen brands for it AND still offers social sign-in, so a social
  // sign-up on this URL lands in the right org.
  await page.goto("/en/sign-in/default");
  await expect(page.getByText(/sign in to default organization/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with microsoft/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
  // An unknown org silently falls back to the plain screen (no branding).
  await page.goto("/en/sign-in/no-such-org");
  await expect(page.getByText(/sign in to no-such-org/i)).toHaveCount(0);
});
