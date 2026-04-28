import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for end-to-end and accessibility suites.
 *
 * The dev server is started by the test harness when not already running.
 * Suites run sequentially in CI to keep DB seeds deterministic.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/**/*.spec.ts", "accessibility/**/*.spec.ts"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : {
        command: "pnpm dev",
        port: 3000,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
