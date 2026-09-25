import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the self-service Account app: a signed-in user can view their
 * own information and edit it, with changes persisting across a reload.
 * Runs as the seed admin (who, like every active member, holds the
 * baseline `shell.view` and so can reach the user-level Account app).
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("overview shows the user's own account info", async ({ page }) => {
  await page.goto("/en/app/account");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  // The seed admin's email is rendered in the identity card.
  await expect(page.getByText("admin@devresponse.local").first()).toBeVisible();
});

test("overview lists the user's own permissions", async ({ page }) => {
  await page.goto("/en/app/account");
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();

  const permissions = page.getByTestId("account-permissions");
  await expect(permissions).toBeVisible();
  // Every active member holds the baseline shell permission, so it must be
  // present and individually addressable for assertions.
  await expect(permissions.locator('[data-permission="shell.view"]')).toBeVisible();
});

test("profile edit persists across a reload, then restores", async ({ page }) => {
  await page.goto("/en/app/account/profile");
  const displayName = page.getByLabel("Display name", { exact: true });
  await expect(displayName).toBeVisible();

  const original = await displayName.inputValue();
  const next = `E2E Display ${Date.now()}`;

  try {
    await displayName.fill(next);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    // Persisted: a fresh navigation re-renders the server value.
    await page.goto("/en/app/account/profile");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(next);
  } finally {
    // Restore so repeated runs stay clean.
    await page.goto("/en/app/account/profile");
    await page.getByLabel("Display name", { exact: true }).fill(original);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toBeVisible();
  }
});

test("preferences edit persists across a reload, then restores", async ({ page }) => {
  await page.goto("/en/app/account/preferences");
  const dateFormat = page.getByLabel("Date format");
  await expect(dateFormat).toBeVisible();

  const original = await dateFormat.inputValue();
  const next = original === "us" ? "eu" : "us";

  try {
    await dateFormat.selectOption(next);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    await page.goto("/en/app/account/preferences");
    await expect(page.getByLabel("Date format")).toHaveValue(next);
  } finally {
    await page.goto("/en/app/account/preferences");
    await page.getByLabel("Date format").selectOption(original);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toBeVisible();
  }
});

/**
 * F-37: the preferences used to be saved and then read by nothing. The time
 * zone and date format must reach a server-rendered page (Account overview)
 * and a client-rendered one (the Security page's session list), and a new
 * language must move the page to it.
 */
test("saved time zone, date format and language apply across the app (F-37)", async ({ page }) => {
  await page.goto("/en/app/account/preferences");
  const select = (name: string) => page.locator(`select[name="${name}"]`);
  const original = {
    preferredLocale: await select("preferredLocale").inputValue(),
    timeZone: (await select("timeZone").inputValue()) || null,
    dateFormat: await select("dateFormat").inputValue(),
    numberFormatLocale: await select("numberFormatLocale").inputValue(),
  };

  try {
    // Eucla is UTC+8:45 (no DST): no host or CI runner zone produces its
    // minutes. The option list is the BROWSER's Intl.supportedValuesOf, which
    // spells some zones by their old ICU names (Chromium lists "Asia/Katmandu",
    // not "Asia/Kathmandu"); Eucla has one name in ICU and IANA alike, so the
    // option exists in every engine.
    await select("timeZone").selectOption("Australia/Eucla");
    await select("dateFormat").selectOption("iso8601");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    // Server-rendered: "Member since" in the ISO date format.
    await page.goto("/en/app/account");
    const memberSince = page
      .locator("dt", { hasText: "Member since" })
      .locator("xpath=following-sibling::dd[1]");
    await expect(memberSince).toHaveText(/^\d{4}-\d{2}-\d{2}$/);

    // Client-rendered: this session's expiry, in Eucla time, ISO format.
    const session = (await (await page.request.get("/api/auth/get-session")).json()) as {
      session: { expiresAt: string };
    };
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Australia/Eucla",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(session.session.expiresAt))
        .map((p) => [p.type, p.value]),
    );
    const expected = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    await page.goto("/en/app/account/security");
    // Other sessions of the seed admin may expire in the same minute.
    await expect(page.getByText(`Expires ${expected}`).first()).toBeVisible();

    // Language: the save moves this page to French at once.
    await page.goto("/en/app/account/preferences");
    await select("preferredLocale").selectOption("fr");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/fr\/app\/account\/preferences$/);
    await expect(page.getByRole("heading", { level: 1, name: "Préférences" })).toBeVisible();
  } finally {
    // Restore through the API so the seed admin is left as found whatever
    // language the page ended up in.
    const res = await page.request.put("/api/account/preferences", {
      headers: ADMIN_API_HEADERS,
      data: original,
    });
    expect(res.ok()).toBe(true);
  }
});

test("security page exposes the password change form", async ({ page }) => {
  await page.goto("/en/app/account/security");
  // These fields are required, so their labels carry an asterisk now —
  // match by prefix (anchored so "New password" doesn't hit "Confirm new…").
  await expect(page.getByLabel(/^Current password/)).toBeVisible();
  await expect(page.getByLabel(/^New password/)).toBeVisible();
});
