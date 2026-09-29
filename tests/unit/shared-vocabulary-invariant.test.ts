import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import en from "@/messages/en.json";
import {
  APP_STATUS_VALUES,
  APP_USER_STATUS_VALUES,
  CREDENTIAL_STATUS_VALUES,
  MEMBERSHIP_STATUS_VALUES,
  ORGANIZATION_STATUSES,
} from "@/lib/status-values";
import {
  calleeName,
  parseSource,
  pathBelow,
  reachableCalls,
  routeHandlers,
} from "../helpers/handler-scan";

/**
 * F-133: the shared chokepoints stay the only copies.
 *
 * Three helpers already existed when the 2026-09-22 review ran, and sibling
 * code kept its own copy of each beside them:
 *
 *   - `loadScopedOrg` (`lib/admin/org-route.server.ts`): the members and
 *     provider-bindings sub-routes re-implemented the org load and ADR-0001
 *     scope check in all seven of their handlers, so a boundary change made
 *     in the helper would have reached the other sub-routes but not those.
 *   - the UUID pattern (`lib/uuid.ts`): fourteen modules declared their own.
 *   - the status vocabularies (`lib/status-values.ts`, which
 *     `migration-status-check-sync.test.ts` holds to the DB CHECKs; it
 *     re-exports the organization and enterprise-app lists from the modules
 *     that own them): four route `z.enum`s, four route filter allow-lists
 *     (one an `===` chain), the admin OpenAPI spec, five console grids and
 *     the user page spelled the values out. A status a migration added would
 *     have passed the sync test and still been refused (a 400) or dropped (a
 *     filter) by those routes, undocumented in the spec, with nothing
 *     failing.
 *
 * A copy re-introduced anywhere under `src/` fails here. (The organization
 * settings form's status select maps the vocabulary through a
 * `Record<OrganizationStatus, …>` of labels, so typecheck guards that one.)
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
// `[id]` is a literal directory name; join() keeps the brackets as-is.
const ORG_SUBROUTES_DIR = join(SRC_DIR, "app", "api", "administrator", "organizations", "[id]");

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(entry)) out.push(full);
  }
  return out;
}

const SOURCES = walk(SRC_DIR, (name) => /\.tsx?$/.test(name)).map((full) => ({
  file: pathBelow(SRC_DIR, full),
  text: readFileSync(full, "utf8"),
}));

/**
 * `x === "a" || x === "b" …` over a whole vocabulary, in its order (or the
 * negated `!==` / `&&` form): an allow-list written as a comparison chain.
 */
function comparisonChain(values: readonly string[]): RegExp {
  const [first, ...rest] = values.map((value) => String.raw`\s*[!=]==\s*["']${value}["']`);
  const more = rest.map((compare) => String.raw`\s*(?:\|\||&&)\s*\1${compare}`).join("");
  return new RegExp(String.raw`([\w$.]+)${first}${more}`);
}

/** Source files (below `src/`) whose text matches `pattern`, minus `owner`. */
function filesMatching(pattern: RegExp, owner: string): string[] {
  return SOURCES.filter(({ file, text }) => file !== owner && pattern.test(text)).map(
    ({ file }) => file,
  );
}

describe("shared chokepoints have no copies (F-133)", () => {
  it("scans the source tree", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES.some(({ file }) => file === "lib/uuid.ts")).toBe(true);
  });

  it("declares the UUID pattern only in lib/uuid.ts", () => {
    // The hex-group head of the pattern, in either case spelling.
    expect(filesMatching(/\[0-9a-f(?:A-F)?\]\{8\}-/i, "lib/uuid.ts")).toEqual([]);
  });

  it("spells out the membership and app-user status vocabularies only in status-values.ts", () => {
    // Both lists open with these four values in this order (app users add
    // `deactivated`); a deliberate subset such as `["active",
    // "pending_approval"]` does not match.
    const vocabulary =
      /["']active["'],\s*["']pending_approval["'],\s*["']blocked["'],\s*["']suspended["']/;
    expect(filesMatching(vocabulary, "lib/status-values.ts")).toEqual([]);
  });

  it("spells out the credential status vocabulary only in status-values.ts", () => {
    expect(
      filesMatching(/\[\s*["']active["'],\s*["']revoked["']\s*\]/, "lib/status-values.ts"),
    ).toEqual([]);
  });

  it("spells out the organization status vocabulary only in validation/organizations.ts", () => {
    expect(
      filesMatching(
        /["']active["'],\s*["']pending["'],\s*["']suspended["'],\s*["']archived["']/,
        "lib/validation/organizations.ts",
      ),
    ).toEqual([]);
  });

  it("spells out the enterprise-app status vocabulary only in admin/enterprise-apps.ts", () => {
    expect(
      filesMatching(
        /\[\s*["']available["'],\s*["']disabled["']\s*\]/,
        "lib/admin/enterprise-apps.ts",
      ),
    ).toEqual([]);
  });

  it.each([
    ["app-user", APP_USER_STATUS_VALUES],
    ["membership", MEMBERSHIP_STATUS_VALUES],
    ["credential", CREDENTIAL_STATUS_VALUES],
    ["organization", ORGANIZATION_STATUSES],
    ["enterprise-app", APP_STATUS_VALUES],
  ] as const)("compares nothing against the whole %s vocabulary in an === chain", (_, values) => {
    const chain = comparisonChain(values);
    // The pattern finds the shape it is for, so an empty result means something.
    const spelled = values.map((value) => `query.filters.status === "${value}"`).join(" ||\n  ");
    expect(chain.test(`if (${spelled}) {`)).toBe(true);
    expect(filesMatching(chain, "")).toEqual([]);
  });

  describe("every /administrator/organizations/[id]/* sub-route loads its org via loadScopedOrg", () => {
    // The org's own route (`[id]/route.ts`) is not a sub-route: its PATCH and
    // DELETE are cross-org-reach actions with their own lookup order.
    const files = walk(ORG_SUBROUTES_DIR, (name) => name === "route.ts").filter(
      (full) => pathBelow(ORG_SUBROUTES_DIR, full) !== "route.ts",
    );

    it("finds the sub-routes", () => {
      expect(files.map((full) => pathBelow(ORG_SUBROUTES_DIR, full)).sort()).toEqual(
        expect.arrayContaining(["members/route.ts", "provider-bindings/route.ts"]),
      );
    });

    const cases = files.flatMap((full) => {
      const sf = parseSource(full, readFileSync(full, "utf8"));
      return routeHandlers(sf).map((handler) => ({
        name: `${pathBelow(ORG_SUBROUTES_DIR, full)}#${handler.method}`,
        calls: handler.body === null ? [] : reachableCalls(sf, handler.body),
      }));
    });

    it.each(cases)("$name", ({ calls }) => {
      expect(calls.some((call) => calleeName(call) === "loadScopedOrg")).toBe(true);
      const ownOrgLoad = calls.some(
        (call) =>
          calleeName(call) === "selectFrom" &&
          call.arguments.some(
            (arg) => ts.isStringLiteral(arg) && arg.text.split(" ")[0] === "app_organizations",
          ),
      );
      expect(ownOrgLoad).toBe(false);
    });
  });

  it("labels every status the console offers, now that the lists come from the vocabulary", () => {
    // The user page translates a status only when it is in the vocabulary,
    // and the grids offer every vocabulary value as a filter option, so each
    // value needs its label (the locale parity test carries it to the rest).
    const offered = [
      ...APP_USER_STATUS_VALUES,
      ...MEMBERSHIP_STATUS_VALUES,
      ...CREDENTIAL_STATUS_VALUES,
      ...ORGANIZATION_STATUSES,
      ...APP_STATUS_VALUES,
    ];
    for (const status of APP_USER_STATUS_VALUES) {
      expect(en.administrator.users.status).toHaveProperty(status);
    }
    for (const status of offered) {
      expect(en.administrator.grid.optionLabels).toHaveProperty(status);
    }
  });
});
