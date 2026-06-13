import { expect, test } from "@playwright/test";
import { signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the Administrator overview dashboard (docs/admin-manager.md
 * §8.1) renders both tiers for the seeded platform admin: the five
 * permission-gated metric cards and the four recent-activity tables.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("dashboard renders metric cards and activity tables", async ({ page }) => {
  await page.goto("/en/app/administrator");

  await expect(page.getByRole("heading", { name: "Administrator overview" })).toBeVisible();

  // Tier 1: the seeded admin holds every read permission → 5 cards,
  // each linking to its area.
  const cards = page.locator('[data-slot="metric-card"]');
  await expect(cards).toHaveCount(5);

  // Tier 2: all four recent-activity tables.
  const lists = page.locator('[data-slot="overview-list-card"]');
  await expect(lists).toHaveCount(4);
  await expect(page.getByText("Latest registrations")).toBeVisible();
  await expect(page.getByText("Latest sign-ins")).toBeVisible();
  await expect(page.getByText("Latest audit events")).toBeVisible();
  await expect(page.getByText("Latest organizations")).toBeVisible();

  // The seed admin exists, so registrations is never empty.
  await expect(
    page
      .locator('[data-slot="overview-list-card"]', { hasText: "Latest registrations" })
      .getByRole("row"),
  ).not.toHaveCount(0);
});
