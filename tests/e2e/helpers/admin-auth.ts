import type { Page } from "@playwright/test";

/**
 * Authenticated-suite helpers.
 *
 * The seed script (`pnpm db:seed`) provisions a known admin account;
 * suites sign in through the real Better Auth API so the session
 * cookie lands in the browser context exactly as it would for a user.
 * Credentials come from the same env vars the seed consumes, with the
 * `.env.example` defaults as fallback.
 */
export const SEED_ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? "admin@devresponse.local",
  password: process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe-LocalOnly-123!",
};

/**
 * Headers for administrator API mutations issued via `page.request`.
 * The admin origin guard requires an `Origin`/`Referer` on unsafe
 * methods (CSRF defence-in-depth) — a browser sends it automatically,
 * Playwright's request fixture does not.
 */
export const ADMIN_API_HEADERS = {
  origin: new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000").origin,
};

/** Signs the page's browser context in as the seeded admin. */
export async function signInAsSeedAdmin(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
  });
  if (!res.ok()) {
    throw new Error(
      `Seed admin sign-in failed (${res.status()}). ` +
        "Is the database migrated and seeded? Run: pnpm db:up && pnpm db:auth:migrate && pnpm db:app:migrate && pnpm db:seed",
    );
  }
}
