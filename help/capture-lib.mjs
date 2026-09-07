// Pure helpers for the help-screenshot capture script (help/capture.mjs).
//
// They live in their own module so they can be unit-tested WITHOUT a browser
// (tests/unit/help-capture-tooling.test.ts): the capture script itself is
// top-level `await` + Playwright, so nothing else can import it.
//
// This is OPERATOR TOOLING, not servable help content — .dockerignore keeps it
// out of the runtime image alongside capture.mjs (#182).

/** Canonical UUID shape used by every admin detail route. */
export const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * Picks the first entity id out of a list page's hrefs (review #237).
 *
 * The script used to hard-code the demo database's UUIDs, so a re-seeded demo
 * silently produced a wall of 404 screenshots. Ids are now read from the list
 * page that was just captured, which is by definition current.
 *
 * @param {string[]} hrefs   every `href` on the list page
 * @param {string} segment   admin route segment, e.g. "users"
 * @returns {string} the first matching id
 * @throws when the list page offered no detail link — a re-seeded, EMPTY demo
 *         must fail the run loudly rather than shoot a 404.
 */
export function pickIdFromHrefs(hrefs, segment) {
  const re = new RegExp(`/app/administrator/${segment}/(${UUID_PATTERN})(?:[/?#]|$)`);
  for (const href of hrefs) {
    const match = re.exec(String(href ?? ""));
    if (match) return match[1];
  }
  throw new Error(
    `capture: no /${segment}/<id> link on the ${segment} list page — is the demo database seeded? ` +
      `Set CAPTURE_${segment.toUpperCase()}_ID to capture a specific row.`,
  );
}

/**
 * Asserts a navigation actually succeeded (review #237).
 *
 * `page.goto` resolves for a 404 or a 500 just as happily as for a 200 — the
 * repo learned the same lesson with the PDF renderer printing a not-found page
 * as a valid document. A screenshot of an error page is worse than no
 * screenshot, so anything outside 2xx aborts the run.
 *
 * @param {{status: () => number} | null} response  what `page.goto` returned
 * @param {string} route
 */
export function assertOk(response, route) {
  if (!response) {
    throw new Error(`capture: no HTTP response for ${route} (navigation was aborted)`);
  }
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw new Error(`capture: ${route} returned HTTP ${status} — refusing to screenshot it`);
  }
  return status;
}
