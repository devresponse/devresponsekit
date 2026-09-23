import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-07 — systemic guard for impersonation attribution.
 *
 * `auditEvent` names the human behind an impersonated session only when the
 * request's SESSION READ recorded the impersonation
 * (`noteSessionImpersonation`). Two chokepoints do that for almost everything:
 * the caller resolver behind every guard, and `getCurrentSession` for the
 * ambient headers the RSC admin gate audits with. A route that reads the
 * session DIRECTLY and audits with its own `request` is outside both, and would
 * quietly go back to naming the borrowed identity — so this scan fails CI when
 * a route calls `getCurrentSession()` without recording it, unless the route is
 * in the reviewed map below with a reason. Stale entries fail too.
 *
 * It also pins the chokepoints themselves, since deleting one line there
 * reverts the fix for every guarded route at once.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");

const DIRECT_SESSION_READ = /\bgetCurrentSession\s*\(/;
const RECORDS_IMPERSONATION = /\bnoteSessionImpersonation\s*\(/;

/** Routes that read the session directly and need not record it — each with the reason. */
const EXEMPT: Record<string, string> = {
  "administrator/users/[id]/impersonate/route.ts":
    "POST re-reads the session only to confirm the principal Better Auth will act on (its guard already recorded it) and refuses a borrowed one; DELETE attributes the stop to `impersonatedBy` explicitly and keys its bucket on it",
  "preferences/active-org/apply/route.ts":
    "refuses an impersonated session with a plain redirect before it audits or rate-limits anything",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const routes = walk(API_ROUTES_DIR).map((file) => ({
  rel: relative(API_ROUTES_DIR, file).split(sep).join("/"),
  source: readFileSync(file, "utf8"),
}));
const directReaders = routes.filter((r) => DIRECT_SESSION_READ.test(r.source));

describe("impersonation attribution invariant (F-07)", () => {
  it("finds the direct session readers (the scan is not vacuous)", () => {
    // Navigation menus x3, invitation acceptance, SSO launch, plus the two exemptions.
    expect(directReaders.length).toBeGreaterThanOrEqual(7);
  });

  it("every route that reads the session directly records an impersonation (or is exempt)", () => {
    const offenders = directReaders
      .filter((r) => !(r.rel in EXEMPT) && !RECORDS_IMPERSONATION.test(r.source))
      .map((r) => r.rel);
    expect(
      offenders,
      "call noteSessionImpersonation(request, session) after getCurrentSession(), or add a reviewed EXEMPT entry",
    ).toEqual([]);
  });

  it("has no stale exemptions", () => {
    for (const rel of Object.keys(EXEMPT)) {
      const route = routes.find((r) => r.rel === rel);
      expect(route, `${rel} no longer exists`).toBeDefined();
      expect(DIRECT_SESSION_READ.test(route!.source), `${rel} no longer reads the session`).toBe(
        true,
      );
      expect(
        RECORDS_IMPERSONATION.test(route!.source),
        `${rel} records the impersonation now — drop its exemption`,
      ).toBe(false);
    }
  });

  it("keeps both session-read chokepoints recording, and auditEvent applying the rule", () => {
    const read = (rel: string) => readFileSync(join(SRC_DIR, rel), "utf8");
    expect(read("lib/api-auth/resolve-caller.server.ts")).toMatch(
      /noteSessionImpersonation\(request, session\)/,
    );
    expect(read("lib/auth-guard.ts")).toMatch(
      /noteSessionImpersonation\(requestHeaders, session\)/,
    );
    expect(read("lib/audit.server.ts")).toMatch(/attributeAuditActor\(input\)/);
  });
});
