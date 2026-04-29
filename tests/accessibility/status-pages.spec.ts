import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility §29.9.3–4 — the localized status pages (pending approval,
 * blocked, logged-out) are publicly reachable and must report no axe
 * violations at the WCAG 2.1 AA tag set.
 */
const PUBLIC_STATUS_PAGES = ["/en/pending-approval", "/en/blocked", "/en/logged-out"] as const;

for (const path of PUBLIC_STATUS_PAGES) {
  test(`${path} has no axe violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
