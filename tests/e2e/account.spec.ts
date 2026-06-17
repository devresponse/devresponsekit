import { expect, test } from "@playwright/test";
import { signInAsSeedAdmin } from "./helpers/admin-auth";

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

test("security page exposes the password change form", async ({ page }) => {
  await page.goto("/en/app/account/security");
  // These fields are required, so their labels carry an asterisk now —
  // match by prefix (anchored so "New password" doesn't hit "Confirm new…").
  await expect(page.getByLabel(/^Current password/)).toBeVisible();
  await expect(page.getByLabel(/^New password/)).toBeVisible();
});
