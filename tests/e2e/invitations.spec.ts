import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";
import { readOutboxDeliveryLink } from "./helpers/outbox-db";

/**
 * End-to-end proof of the invitation flow (0008):
 *
 *   admin invites an address → the accept link lands in the outbox →
 *   a NEW user opens it, creates an account with the locked invited email →
 *   the account is pre-verified (no verify-email bounce), signed in
 *   immediately, and lands ACTIVE in the app — no admin approval step.
 *
 * The accept link is pulled from the outbox row's DB-only delivery payload
 * (outbox-first delivery records every email even with no provider
 * configured), so the test exercises the REAL emailed URL. The admin email
 * API serves the same row REDACTED (review #21) — proven here too — so an
 * org admin can never lift a live accept link from the outbox.
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

  // The outbox row is listed (metadata only, #221) and its detail carries
  // the email with the token REDACTED (#21).
  const outboxRes = await page.request.get(
    `/api/administrator/email/outbox?q=${encodeURIComponent(email)}&page=1&pageSize=5`,
  );
  expect(outboxRes.ok()).toBeTruthy();
  const outbox = (await outboxRes.json()) as { items: Array<{ id: string; body_html?: string }> };
  expect(outbox.items.length).toBeGreaterThan(0);
  expect(outbox.items[0]!.body_html).toBeUndefined();
  const detailRes = await page.request.get(
    `/api/administrator/email/outbox/${outbox.items[0]!.id}`,
  );
  expect(detailRes.ok()).toBeTruthy();
  const detail = (await detailRes.json()) as { body_html: string };
  expect(detail.body_html).toContain("/invite?token=[redacted]");
  expect(detail.body_html).not.toMatch(/\/invite\?token=(?!\[redacted\])/);

  // The REAL accept URL exists only in the DB-only delivery payload.
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
