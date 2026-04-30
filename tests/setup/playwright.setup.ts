/**
 * Playwright global setup.
 *
 * Runs once before all Playwright E2E and accessibility suites.
 * Primarily used to verify the dev server is healthy and to set up
 * any global test fixtures.
 *
 * This file is referenced by `playwright.config.ts` via the
 * `globalSetup` option. It MUST export a default async function.
 */
export default async function playwrightSetup() {
  // Currently no global setup is required.
  // Future: seed test database, create shared auth state files, etc.
}
