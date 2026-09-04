import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Pins two one-line hardening settings that nothing else in the test suite
 * would notice if they regressed (review #115 / #124):
 *
 *   - `next.config.mjs` must set `poweredByHeader: false` so no response
 *     advertises `X-Powered-By: Next.js` (the static header list cannot strip
 *     a header the server itself adds).
 *   - `playwright.config.ts` must set `forbidOnly: !!process.env.CI` so a
 *     committed `test.only` FAILS the required E2E check instead of silently
 *     shrinking it to the focused cases (vitest already has `allowOnly: !CI`).
 *
 * Source scans (like tests/security/locale-switch-protection.test.ts) — the
 * Next config pulls in the next-intl + Sentry plugins, and the Playwright
 * config is not importable under vitest.
 */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

describe("next.config.mjs hardening (review #115)", () => {
  it("disables the X-Powered-By header", () => {
    expect(read("next.config.mjs")).toMatch(/poweredByHeader:\s*false/);
  });
});

describe("playwright.config.ts hardening (review #124)", () => {
  it("forbids a committed .only under CI", () => {
    expect(read("playwright.config.ts")).toMatch(/forbidOnly:\s*!!process\.env\.CI/);
  });
});
