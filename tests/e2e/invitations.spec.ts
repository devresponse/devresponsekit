import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * End-to-end proof of the invitation flow (0008):
 *
 *   admin invites an address → the accept link lands in the outbox →
 *   a NEW user opens it, creates an account with the locked invited email →
 *   the account is pre-verified (no verify-email bounce), signed in
 *   immediately, and lands ACTIVE in the app — no admin approval step.
 *
 * The accept link is pulled from the outbox through the admin email API
 * (outbox-first delivery records every email even with no provider
 * configured), so the test exercises the REAL emailed URL.
 */
test("invited user signs up via the emailed link and lands active in the app", async ({ page }) => {
  await signInAsSeedAdmin(page);

  const orgsRes = await page.request.get("/api/administrator/organizations?page=1&pageSize=1");
  expect(orgsRes.ok()).toBeTruthy();
  const orgId = ((await orgsRes.json()) as { items: Array<{ id: string }> }).items[0]!.id;

  const email = `e2e-invitee-${Date.now()}@dbtest.local`;
  const createRes = await page.request.post(
    `/api/administrator/organizations/${orgId}/invitations`,
    { headers: ADMIN_API_HEADERS, data: { email } },
  );
  expect(createRes.status()).toBe(201);

  // The outbox row holds the rendered email; extract the accept URL.
  const outboxRes = await page.request.get(
    `/api/administrator/email/outbox?q=${encodeURIComponent(email)}&page=1&pageSize=5`,
  );
  expect(outboxRes.ok()).toBeTruthy();
  const outbox = (await outboxRes.json()) as { items: Array<{ body_html: string }> };
  expect(outbox.items.length).toBeGreaterThan(0);
  const match = outbox.items[0]!.body_html.match(/href="([^"]*\/invite\?token=[^"]+)"/);
  expect(match, "outbox email should carry the accept link").toBeTruthy();
  const acceptUrl = new URL(match![1]!);

  // Continue as the INVITEE: fresh session.
  await page.context().clearCookies();
  await page.goto(acceptUrl.pathname + acceptUrl.search);
  // Role-scoped: the guest panel's description also starts with this phrase.
  await expect(page.getByRole("heading", { name: "You've been invited" })).toBeVisible();

  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page.getByText(/finish creating your account/i)).toBeVisible();
  const emailInput = page.getByLabel(/email/i);
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).toBeDisabled();

  await page.getByLabel(/^name/i).fill("E2E Invitee");
  await page.getByLabel(/password/i).fill("Sup3r-Secret-E2E!");
  await page.getByRole("button", { name: /create account/i }).click();

  // Pre-verified + active: straight into the app, no verify-email page and
  // no pending-approval gate.
  await page.waitForURL(/\/en\/app(\/|$)/, { timeout: 15_000 });
  expect(page.url()).not.toContain("verify-email");
  expect(page.url()).not.toContain("pending-approval");
});
