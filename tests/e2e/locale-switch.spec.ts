import { expect, test, type Page } from "@playwright/test";
import { ADMIN_API_HEADERS, SEED_ADMIN, signInAsSeedAdmin } from "./helpers/admin-auth";
import { readOutboxDeliveryLink } from "./helpers/outbox-db";

/**
 * Opens the locale switcher (a combobox labelled with the CURRENT locale's
 * word for "Language") and picks another locale by its endonym.
 */
async function switchLanguage(page: Page, comboboxName: RegExp, option: RegExp): Promise<void> {
  await page.getByRole("combobox", { name: comboboxName }).click();
  await page.getByRole("option", { name: option }).click();
}

/**
 * E2E §29.8.9 — switching locales via the locale switcher must rewrite
 * `/en/...` to `/fr/...` while preserving the rest of the path.
 */
test("locale switcher changes /en/sign-in to /fr/sign-in", async ({ page }) => {
  await page.goto("/en/sign-in");

  // The locale switcher renders as a combobox labelled "Language".
  await switchLanguage(page, /language/i, /français/i);

  await expect(page).toHaveURL(/\/fr\/sign-in/);
});

/**
 * F-35 — the switch keeps the query string byte-for-byte. A signed-out SSO
 * launch sends the visitor to sign-in with a `returnTo` that nests its own
 * query (#464); before the fix a language change dropped it, and signing in
 * then landed on the dashboard instead of the application.
 */
test("locale switcher keeps the sign-in returnTo (F-35)", async ({ page }) => {
  const search = `?returnTo=${encodeURIComponent("/en/sso/launch?applicationId=portal&locale=en")}`;
  await page.goto(`/en/sign-in${search}`);

  await switchLanguage(page, /language/i, /français/i);

  await page.waitForURL(/\/fr\/sign-in\?/);
  expect(new URL(page.url()).search).toBe(search);
});

/**
 * F-35 — a language picked on sign-in holds AFTER sign-in. The signed-out
 * redirect mints `returnTo=/en/app/dashboard`, and the switch keeps it verbatim,
 * so the sign-in page must re-point its locale at its own
 * (`getSafeReturnToInLocale`). Honouring the minted `/en` sent the user back to
 * English after they had chosen French, and the sign-in switcher persists
 * nothing, so the choice was lost. Labels are French from the switch on.
 */
test("a language picked on sign-in holds after signing in (F-35)", async ({ page }) => {
  await page.goto("/en/app/dashboard");
  await page.waitForURL(/\/en\/sign-in\?returnTo=%2Fen%2Fapp%2Fdashboard/);

  await switchLanguage(page, /language/i, /français/i);
  await page.waitForURL(/\/fr\/sign-in\?returnTo=%2Fen%2Fapp%2Fdashboard/);

  await page.getByLabel(/^e-mail/i).fill(SEED_ADMIN.email);
  await page.getByLabel(/^mot de passe/i).fill(SEED_ADMIN.password);
  await page.getByRole("button", { name: /^se connecter$/i }).click();

  await expect(page).toHaveURL(/\/fr\/app\/dashboard/, { timeout: 15_000 });
});

/**
 * F-35 — an invitee who changes language keeps their invitation, on the
 * accept page AND on the invited sign-up it leads to. Before the fix the
 * accept page lost `?token=` (the "invitation not available" panel) and the
 * sign-up lost `?invite=` (no locked email, no invitation in the sign-up
 * body). The accept link is the real emailed one, read from the outbox's
 * DB-only delivery payload exactly as `invitations.spec.ts` does.
 */
test("an invitee keeps the invitation across language switches (F-35)", async ({
  page,
}, testInfo) => {
  await signInAsSeedAdmin(page);

  const orgsRes = await page.request.get("/api/administrator/organizations?page=1&pageSize=1");
  expect(orgsRes.ok()).toBeTruthy();
  const orgId = ((await orgsRes.json()) as { items: Array<{ id: string }> }).items[0]!.id;

  const email = `e2e-locale-invitee-${testInfo.project.name}-${Date.now()}@dbtest.local`;
  const createRes = await page.request.post(
    `/api/administrator/organizations/${orgId}/invitations`,
    { headers: ADMIN_API_HEADERS, data: { email } },
  );
  expect(createRes.status()).toBe(201);

  const acceptLink = await readOutboxDeliveryLink({
    to: email,
    templateKey: "organization_invitation",
    pattern: /href="([^"]*\/invite\?token=[^"]+)"/,
  });
  expect(acceptLink, "outbox delivery payload should carry the accept link").toBeTruthy();
  const acceptUrl = new URL(acceptLink!);

  // Continue as the INVITEE: fresh session.
  await page.context().clearCookies();
  await page.goto(acceptUrl.pathname + acceptUrl.search);
  await expect(page.getByRole("heading", { name: "You've been invited" })).toBeVisible();

  // Accept page → Ukrainian: the token survives, so the invitation is still live.
  await switchLanguage(page, /language/i, /українська/i);
  await page.waitForURL(/\/uk\/invite\?/);
  expect(new URL(page.url()).search).toBe(acceptUrl.search);
  await expect(page.getByRole("heading", { name: "Вас запрошено" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Запрошення недоступне" })).toHaveCount(0);

  // Invited sign-up → French: the invitation, and with it the locked email,
  // survives this switch too.
  await page.getByRole("link", { name: "Створити обліковий запис" }).click();
  await page.waitForURL(/\/uk\/sign-up\?invite=/);
  const signUpSearch = new URL(page.url()).search;

  await switchLanguage(page, /мова/i, /français/i);
  await page.waitForURL(/\/fr\/sign-up\?/);
  expect(new URL(page.url()).search).toBe(signUpSearch);
  const emailInput = page.locator('input[type="email"]');
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).toBeDisabled();
});
