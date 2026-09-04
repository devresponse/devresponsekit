import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";
import { readOutboxDeliveryLink } from "./helpers/outbox-db";

/**
 * E2E — the email subsystem (specs.md §35) end to end:
 *
 *   1. The administrator "send test email" pipeline records every
 *      outbound email in the outbox; without a configured provider
 *      (local dev + CI) the row is kept as `logged`.
 *   2. The full password-reset round trip: the forgot-password form
 *      triggers Better Auth's `sendResetPassword`, the rendered email
 *      lands in the outbox, and the link it contains actually resets
 *      the password through the `/reset-password` page. The admin API
 *      serves that row REDACTED (review #21 — no live token for an org
 *      admin to lift), so the real link is read from the DB-only
 *      `delivery_payload` column via the `outbox-db` helper.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

interface OutboxItem {
  id: string;
  template_key: string | null;
  to_email: string;
  subject: string;
  status: string;
}

interface OutboxDetail extends OutboxItem {
  body_html: string;
  body_text: string | null;
}

test("test email is recorded in the outbox and visible in the email workspace", async ({
  page,
}, testInfo) => {
  const to = `e2e.outbox.${testInfo.project.name}.${Date.now()}@devresponse.local`;

  const send = await page.request.post("/api/administrator/email/test", {
    headers: ADMIN_API_HEADERS,
    data: { to },
  });
  expect(send.status(), await send.text()).toBe(200);
  const sendBody = (await send.json()) as { ok: boolean; status: string };
  // No EMAIL_PROVIDER configured in dev/CI — recorded, not delivered.
  expect(sendBody.status).toBe("logged");

  // The row is queryable through the admin API…
  const list = await page.request.get(
    `/api/administrator/email/outbox?q=${encodeURIComponent(to)}`,
  );
  expect(list.ok()).toBe(true);
  const listBody = (await list.json()) as { items: OutboxItem[] };
  const row = listBody.items.find((i) => i.to_email === to);
  expect(row, `outbox row for ${to} should exist`).toBeDefined();
  expect(row!.template_key).toBe("test_email");
  expect(row!.status).toBe("logged");

  // …and renders in the Email workspace grid.
  await page.goto(`/en/app/administrator/email?q=${encodeURIComponent(to)}`);
  await expect(page.getByRole("heading", { name: "Email outbox" })).toBeVisible();
  await expect(page.getByText(to).first()).toBeVisible();
});

test("password reset round trip: form → outbox → emailed link → new password", async ({
  page,
  browser,
}, testInfo) => {
  const email = `e2e.reset.${testInfo.project.name}.${Date.now()}@devresponse.local`;
  const initialPassword = "E2e-Reset-Initial-123!";
  const newPassword = "E2e-Reset-NewPass-456!";

  // Provision an active user through the real admin API.
  const create = await page.request.post("/api/administrator/users", {
    headers: ADMIN_API_HEADERS,
    data: {
      email,
      password: initialPassword,
      name: "E2E Reset",
      role: "user",
      initialAppStatus: "active",
      preferredLocale: "en",
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  const { id } = (await create.json()) as { id: string };

  try {
    // Request the reset through the public forgot-password form.
    const context = await browser.newContext();
    try {
      const userPage = await context.newPage();
      await userPage.goto("/en/forgot-password");
      await userPage.getByLabel(/email/i).fill(email);
      await userPage.getByRole("button", { name: /send reset link/i }).click();
      await expect(userPage.getByRole("status")).toBeVisible();

      // The rendered email is in the outbox (admin cookie jar on `page`)…
      let rowId: string | undefined;
      await expect
        .poll(async () => {
          const list = await page.request.get(
            `/api/administrator/email/outbox?q=${encodeURIComponent(email)}`,
          );
          if (!list.ok()) return false;
          const body = (await list.json()) as { items: OutboxItem[] };
          rowId = body.items.find(
            (i) => i.to_email === email && i.template_key === "password_reset",
          )?.id;
          return Boolean(rowId);
        })
        .toBe(true);

      // …the list carries no bodies (#221), and the detail serves them
      // REDACTED (#21): the admin surface never exposes the live token.
      const detail = await page.request.get(`/api/administrator/email/outbox/${rowId}`);
      expect(detail.status(), await detail.text()).toBe(200);
      const detailBody = (await detail.json()) as OutboxDetail;
      expect(detailBody.body_text).toContain("/reset-password/[redacted]?");
      expect(detailBody.body_text).not.toMatch(/\/reset-password\/(?!\[redacted\])[^/?\s]+/);
      expect(detailBody.body_html).not.toMatch(/\/reset-password\/(?!\[redacted\])[^/?"]+/);

      // The REAL link lives only in the DB-only delivery payload.
      let resetUrl: string | undefined;
      await expect
        .poll(async () => {
          resetUrl = await readOutboxDeliveryLink({
            to: email,
            templateKey: "password_reset",
            pattern: /https?:\/\/\S+\/reset-password\/[^\s"<]+/,
          });
          return Boolean(resetUrl);
        })
        .toBe(true);

      // Follow the emailed link and choose a new password.
      await userPage.goto(resetUrl!);
      await expect(userPage).toHaveURL(/reset-password/);
      await userPage.getByLabel(/^new password/i).fill(newPassword);
      await userPage.getByLabel(/confirm password/i).fill(newPassword);
      await userPage.getByRole("button", { name: /set new password/i }).click();
      await expect(userPage.getByRole("status")).toBeVisible();

      // The new password signs in; the old one no longer does.
      const fresh = await browser.newContext();
      try {
        const freshPage = await fresh.newPage();
        const oldSignIn = await freshPage.request.post("/api/auth/sign-in/email", {
          data: { email, password: initialPassword },
        });
        expect(oldSignIn.ok()).toBe(false);
        const newSignIn = await freshPage.request.post("/api/auth/sign-in/email", {
          data: { email, password: newPassword },
        });
        expect(newSignIn.ok(), await newSignIn.text()).toBe(true);
      } finally {
        await fresh.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    // Cleanup: soft-delete through the admin API.
    const del = await page.request.delete(`/api/administrator/users/${id}`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(del.ok(), await del.text()).toBe(true);
  }
});
