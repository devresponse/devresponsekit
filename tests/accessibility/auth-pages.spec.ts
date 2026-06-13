import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility §29.9.1 — the public sign-in page must report no axe
 * violations at the WCAG 2.1 AA tag set.
 */
test("sign-in page has no axe violations", async ({ page }) => {
  await page.goto("/en/sign-in");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/**
 * Accessibility §29.9.2 — the public sign-up page must report no axe
 * violations at the WCAG 2.1 AA tag set.
 */
test("sign-up page has no axe violations", async ({ page }) => {
  await page.goto("/en/sign-up");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/** The forgot-password request form (specs.md §35). */
test("forgot-password page has no axe violations", async ({ page }) => {
  await page.goto("/en/forgot-password");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/** The reset-password landing page, including its token-less error state. */
test("reset-password page has no axe violations", async ({ page }) => {
  await page.goto("/en/reset-password");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
