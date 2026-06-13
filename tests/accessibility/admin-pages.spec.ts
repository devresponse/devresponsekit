import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signInAsSeedAdmin } from "../e2e/helpers/admin-auth";

/**
 * Accessibility — the AUTHENTICATED surface at the WCAG 2.1 AA tag
 * set: the secure dashboard and the Administrator workspace (overview
 * dashboard, users grid, new-record form). Complements the public
 * auth/status page sweeps with the pages real operators live in.
 */
async function expectNoAxeViolations(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // Let client grids settle so axe scans the real content, not skeletons.
  await page.waitForLoadState("networkidle");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("secure dashboard has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/dashboard");
});

test("administrator overview has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/administrator");
});

test("administrator users grid has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/administrator/users");
});

test("create-permission form has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/administrator/permissions/new");
});

test("email outbox has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/administrator/email");
});

test("email templates list has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/administrator/email/templates");
});

test("account overview has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/account");
});

test("account profile form has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/account/profile");
});

test("account preferences form has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/account/preferences");
});

test("account security page has no axe violations", async ({ page }) => {
  await expectNoAxeViolations(page, "/en/app/account/security");
});
