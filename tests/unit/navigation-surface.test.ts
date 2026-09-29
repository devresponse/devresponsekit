import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as navigation from "@/lib/navigation.server";
import { SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/**
 * I-02: the navigation API serves only menus the shell actually uses, and
 * every link it serves opens a page.
 *
 * `/api/navigation/nested-apps` shipped with a loader, a client helper and a
 * menu entry, yet no component ever called the helper, and its one entry
 * linked to `/app/workspace/settings`, which has no page. The route was an
 * authenticated, audited surface nothing exercised, so review P3-12 missed
 * its bare `{ error }` envelope. It is deleted; these scans keep the next
 * menu from shipping the same way:
 *
 *   - every static-manifest loader in `navigation.server.ts` (each exported
 *     `load…Menu` but the DB-backed application switcher, whose links are SSO
 *     launch URLs) serves only hrefs that resolve to a `page.tsx`. The probe
 *     caller holds `SUPERUSER_PERMISSIONS`, the widest real grant, and every
 *     manifest entry must be served to it: an entry the permission filter
 *     drops would have its href skipped, so a drop fails instead;
 *   - every `/api/navigation/*` route has a fetch helper in
 *     `navigation-api-client.ts`, a file in `src/` imports that helper, and
 *     every helper fetches a route that exists. That the importer is itself
 *     mounted, not dead code, is `unmounted-code.test.ts`'s job: it holds
 *     every non-convention module and component in `src/`, `src/app`
 *     included, to having a production importer and a render site.
 */

vi.mock("@/db/database", () => ({ db: {} }));

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const LOCALE_DIR = join(SRC_DIR, "app", "[locale]");
const NAV_API_DIR = join(SRC_DIR, "app", "api", "navigation");
const CLIENT_FILE = join(SRC_DIR, "components", "navigation", "navigation-api-client.ts");
const LOADER_FILE = join(SRC_DIR, "lib", "navigation.server.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** A URL matcher per `page.tsx` under `[locale]`: route groups drop out, dynamic segments match any. */
function pageMatchers(): RegExp[] {
  return walk(LOCALE_DIR)
    .filter((file) => file.endsWith(`${sep}page.tsx`))
    .map((file) => {
      const segments = relative(LOCALE_DIR, file)
        .split(sep)
        .slice(0, -1)
        .filter((s) => !/^\(.*\)$/.test(s))
        .map((s) =>
          /^\[\[?\.\.\./.test(s)
            ? ".+"
            : /^\[.*\]$/.test(s)
              ? "[^/]+"
              : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        );
      return new RegExp(`^/${segments.join("/")}$`);
    });
}

const SUPERUSER = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: [...SUPERUSER_PERMISSIONS],
};

/** Entries in the static manifests: each is one `href: "/…"` string literal. */
const MANIFEST_ENTRIES = readFileSync(LOADER_FILE, "utf8").match(/^\s+href: "\//gm)?.length ?? 0;

describe("navigation menus link only to pages that exist (I-02)", () => {
  const loaders = Object.entries(navigation).filter(
    ([name, value]) =>
      /^load\w+Menu$/.test(name) && name !== "loadApplicationsMenu" && typeof value === "function",
  ) as Array<[string, typeof navigation.loadShellMenu]>;

  it("finds the static-manifest loaders", () => {
    expect(loaders.map(([name]) => name)).toContain("loadShellMenu");
  });

  it("every href a loader serves resolves to a page.tsx", async () => {
    const matchers = pageMatchers();
    const dead: string[] = [];
    let served = 0;
    for (const [name, load] of loaders) {
      const menu = await load(SUPERUSER, "probe", "en");
      expect(menu.items.length, `${name} serves items`).toBeGreaterThan(0);
      served += menu.items.length;
      for (const item of menu.items) {
        const path = item.href.replace(/^\/en(?=\/|$)/, "").split(/[?#]/)[0] || "/";
        if (!matchers.some((m) => m.test(path))) dead.push(`${name}: ${item.href}`);
      }
    }
    expect(dead).toEqual([]);
    expect(MANIFEST_ENTRIES, "finds the manifest entries").toBeGreaterThan(0);
    expect(
      served,
      "every manifest entry is served to a superuser; a filtered-out entry's href went unchecked",
    ).toBe(MANIFEST_ENTRIES);
  });
});

describe("every navigation API route has a mounted consumer (I-02)", () => {
  const client = readFileSync(CLIENT_FILE, "utf8");
  const helpers = [...client.matchAll(/export function (\w+)\([^)]*\)\s*\{([\s\S]*?)\n\}/g)].map(
    (m) => ({ name: m[1]!, body: m[2]! }),
  );
  const routes = readdirSync(NAV_API_DIR).filter((dir) =>
    existsSync(join(NAV_API_DIR, dir, "route.ts")),
  );
  const importers = walk(SRC_DIR)
    .filter((file) => /\.tsx?$/.test(file) && file !== CLIENT_FILE)
    .map((file) => readFileSync(file, "utf8"));

  it("finds the routes and helpers", () => {
    expect(routes).toContain("shell-menu");
    expect(helpers.map((h) => h.name)).toContain("fetchShellMenu");
  });

  it.each(routes)("/api/navigation/%s is fetched by a helper that src/ imports", (route) => {
    const helper = helpers.find((h) => h.body.includes(`/api/navigation/${route}?`));
    expect(helper, `a navigation-api-client helper fetches /api/navigation/${route}`).toBeDefined();
    const imported = new RegExp(
      `import\\s*\\{[^}]*\\b${helper!.name}\\b[^}]*\\}\\s*from\\s*["']@/components/navigation/navigation-api-client["']`,
    );
    expect(
      importers.some((source) => imported.test(source)),
      `${helper!.name} has an importer in src/`,
    ).toBe(true);
  });

  it("every helper fetches a navigation route that exists", () => {
    const orphans = helpers
      .map((h) => ({ name: h.name, route: /\/api\/navigation\/([\w-]+)\?/.exec(h.body)?.[1] }))
      .filter((h) => !h.route || !routes.includes(h.route))
      .map((h) => h.name);
    expect(orphans).toEqual([]);
  });
});
