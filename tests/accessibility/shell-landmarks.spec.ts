import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signInAsSeedAdmin } from "../e2e/helpers/admin-auth";

/**
 * Shell landmark + hydration integrity (review #102, #104, #105).
 *
 * Three defects the WCAG-AA sweeps could not see, because each produces
 * markup that is individually valid:
 *
 *  - #104 every `(public)` page opened its own `<main>` INSIDE the shell's
 *    main, and the "Skip to navigation" link pointed at `#navigation`,
 *    which the public shell never mounts (`leftVisible={false}`);
 *  - #105 a nested `ApplicationShell` (Account, Administrator, Docs, Help,
 *    Workspace) repeated `id="main"` and `id="navigation"`, so the root
 *    skip links resolved to whichever element the browser found first;
 *  - #102 `useIsMobile` read `window.matchMedia` from a lazy `useState`
 *    initializer, guaranteeing a hydration mismatch on a narrow viewport.
 *    The `mobile` Playwright project is what exercises that branch.
 *
 * The landmark rules run at the `best-practice` tag, which the AA sweeps
 * deliberately exclude; they are scoped to the specific rules rather than
 * the whole tag set so unrelated best-practice advice cannot fail the gate.
 */
const LANDMARK_RULES = [
  "landmark-no-duplicate-main",
  "landmark-unique",
  "duplicate-id-aria",
] as const;

async function expectShellLandmarksClean(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");

  // Exactly one main landmark, and it is the shell's skip-link target.
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("#main")).toHaveCount(1);
  await expect(page.locator("#main")).toHaveJSProperty("tagName", "MAIN");

  // Every id in the document is unique — the property the skip links and
  // every `aria-controls` in the shell depend on.
  const duplicateIds = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of document.querySelectorAll("[id]")) {
      seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  expect(duplicateIds).toEqual([]);

  // Every skip link resolves to an element that actually exists.
  const deadSkipLinks = await page.evaluate(() =>
    [...document.querySelectorAll("a.sh-skip-link")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("#") && !document.getElementById(href.slice(1))),
  );
  expect(deadSkipLinks).toEqual([]);

  const results = await new AxeBuilder({ page }).withRules([...LANDMARK_RULES]).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

/**
 * Everything React emits for a hydration mismatch, on BOTH channels.
 *
 * React 19 reports a mismatch through the default `onRecoverableError`,
 * which calls `reportError()` — Playwright surfaces that as a `pageerror`
 * event, NOT as a console message. A collector subscribed only to
 * `page.on("console")` therefore never observes a mismatch and the
 * assertions below can never fail. Measured against the pre-#102
 * `useIsMobile` (lazy `useState` initializer) on the Pixel 7 project: zero
 * console entries of type `error`, and one `pageerror` reading "Hydration
 * failed because the server rendered HTML didn't match the client." Both
 * listeners stay attached — the Next dev overlay does also log to the
 * console, and a production build reports the minified codes.
 */
function collectHydrationErrors(page: Page): string[] {
  const errors: string[] = [];
  // Dev builds log a prose message; production builds log error #418/#423/#425.
  const record = (text: string) => {
    if (/hydrat|did not match|Minified React error #(418|423|425)/i.test(text)) {
      errors.push(text);
    }
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") record(msg.text());
  });
  page.on("pageerror", (err) => record(`${err.name}: ${err.message}`));
  return errors;
}

/**
 * The hydration assertions only mean something once the SECURE SHELL has
 * actually rendered: an empty error list is also what a redirect to
 * `/sign-in`, a 404 or an error page produces. Without this, a base URL
 * whose auth cookie does not stick keeps both hydration tests green while
 * the nested-shell tests in this same file fail on `#main` count 0.
 */
async function expectSecureShellRendered(page: Page): Promise<void> {
  expect(page.url(), `expected a secure-shell page, got ${page.url()}`).not.toContain("/sign-in");
  await expect(page.locator("#main")).toHaveCount(1);
}

test.describe("public shell", () => {
  for (const path of ["/en/", "/en/about", "/en/docs", "/en/logged-out"]) {
    test(`${path} has one main landmark and no dead skip link`, async ({ page }) => {
      await expectShellLandmarksClean(page, path);
      // The public shell has no left region, so the navigation skip link
      // must not be offered at all (review #104).
      await expect(page.locator("#navigation")).toHaveCount(0);
      await expect(page.locator('a.sh-skip-link[href="#navigation"]')).toHaveCount(0);
    });
  }
});

test.describe("nested workspace shells", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsSeedAdmin(page);
  });

  // One page per nested ApplicationShell call site (review #105).
  for (const path of [
    "/en/app/account",
    "/en/app/administrator",
    "/en/app/workspace",
    "/en/app/docs",
    "/en/app/help",
  ]) {
    test(`${path} keeps the root shell's #main / #navigation unique`, async ({ page }) => {
      await expectShellLandmarksClean(page, path);
      // The root sidebar keeps the bare id; the nested one is suffixed.
      await expect(page.locator("#navigation")).toHaveCount(1);
    });
  }
});

test.describe("hydration", () => {
  // The `mobile` project (Pixel 7, 412px) is the viewport that used to
  // mismatch; the desktop project proves the fix did not just move the
  // mismatch to the other branch (review #102).
  test("secure shell hydrates without a mismatch", async ({ page }) => {
    const errors = collectHydrationErrors(page);
    await signInAsSeedAdmin(page);
    await page.goto("/en/app/dashboard");
    await page.waitForLoadState("networkidle");
    await expectSecureShellRendered(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("account preferences hydrates without a mismatch", async ({ page }) => {
    // The time-zone <select> was built from the runtime's ICU data on both
    // sides (review #108).
    const errors = collectHydrationErrors(page);
    await signInAsSeedAdmin(page);
    await page.goto("/en/app/account/preferences");
    await page.waitForLoadState("networkidle");
    await expectSecureShellRendered(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
