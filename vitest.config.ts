import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * A literal path as a coverage-threshold glob. To picomatch `[id]` is a
 * character class (`i` or `d`), so each bracket is wrapped in a class of its
 * own: `[id]` becomes `[[]id[]]`, which matches that directory and no other.
 */
function literalGlob(path: string): string {
  return path.replace(/[[\]]/g, (bracket) => `[${bracket}]`);
}

/**
 * F-42, extended to the whole tree by F-125: a coverage floor PER ROUTE FILE
 * for every handler under `src/app` (the `/api` tree and the three
 * `.well-known` discovery documents).
 *
 * Vitest applies a glob threshold to the TOTAL of the files it matches
 * (`perFile` is a global-only switch), so one `src/app/api/**` key would let
 * an untested handler hide behind ninety tested ones. The review found
 * `GET` and `DELETE /api/v1/admin/oauth-clients/[id]` in exactly that state,
 * guarded only by a scan that then saw the file import a scope helper. Each file
 * therefore gets a key of its own. The files are read from the tree, so a
 * route added later is floored as soon as it lands, wherever under `src/app`.
 * F-42 floored the `/api/v1` tree and five administrator files; F-125 found the
 * other 49 administrator route files, the 22 elsewhere under `/api` and the
 * three under `.well-known` with no floor at all.
 *
 * `functions: 100` is the floor that matters. Since F-29 every exported method
 * is its own named function (`withV1Route(async function GET(...))`), so a
 * method no test calls takes its file below 100 and fails CI. The other three
 * floors sit a few points below the lowest file F-42 floored, as measured then.
 *
 * A floor proves only that each method is CALLED, not what it checks. The
 * tenant boundary is pinned by tests/security/tenant-handler-reach.test.ts
 * only for the methods F-42 found unexercised: `GET /api/v1/audit-events`,
 * `/api/v1/admin/oauth-clients/[id]`, `DELETE /api/v1/admin/api-keys/[id]`,
 * and the methods that suite calls in five administrator files (`api-keys/[id]`,
 * `email/templates/[id]`, `groups/[id]/roles`, `permissions`, `users/[id]`).
 * Every other floored method relies on its own route tests for that.
 */
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ROUTES_DIR = "src/app";
const API_ROUTES_DIR = "src/app/api";
const ROUTE_FLOOR = { lines: 82, statements: 78, functions: 100, branches: 62 };
/**
 * F-125: the `/api` route handlers taken together, pinned like the global
 * ratchet below (the measured value rounded down, less one point; measured
 * 2026-09-29 at 91.23 lines / 86.71 statements / 91.19 functions / 77.99
 * branches). The per-file floors stop one handler going untested; this one
 * stops the route layer as a whole sliding down to them. Its glob is the
 * `/api` tree only: to picomatch `**` does not enter a dot directory, so the
 * `.well-known` handlers have per-file floors and no share of this one.
 */
const ROUTE_TOTAL_FLOOR = { lines: 90, statements: 85, functions: 90, branches: 76 };
/**
 * Route files measured below `ROUTE_FLOOR`, each pinned at its measured value
 * (rounded down) with the reason. Raise an entry as its tests land and delete
 * it at the shared floor. Never add one to let a new handler in untested.
 *
 * The F-125 entries, measured 2026-09-29, are the gaps the whole-tree floor
 * found, not room it grants: each names the paths no coverage-gated test
 * reaches, which is the test to write. Most have one gap in common: no route
 * test sends a `?q=` search, so the `where((eb) => …)` callback that builds its
 * ILIKE never runs and the file misses `functions: 100`. The tests/db suites
 * run several of these paths against Postgres, but `pnpm test:db` does not
 * feed coverage.
 */
const ROUTE_FLOOR_EXCEPTIONS: Record<string, Partial<typeof ROUTE_FLOOR>> = {
  // POST is invoked, but one inline callback is not: the down-scoping filter
  // (a request whose `scope` asks for more than the credential holds is
  // refused with `invalid_scope`). The two body-parse `.catch` fallbacks went
  // with the byte-capped read (F-78).
  "src/app/api/v1/auth/token/route.ts": { functions: 75 },
  // GET, PATCH and DELETE are invoked. DELETE's body-parse `.catch` fallback
  // is not, nor are most failure branches (a failed Better Auth mirror or ban,
  // a failed compensating unban, a failed cascade).
  "src/app/api/administrator/users/[id]/route.ts": { functions: 80 },
  // F-125 (2026-09-29) from here on. The upsert's `onConflict` callback: the
  // mocked database builder never calls it.
  "src/app/api/account/preferences/route.ts": { functions: 50 },
  "src/app/api/preferences/locale/route.ts": { functions: 66 },
  // POST is invoked, but none of its refusals: a caller with no app user, a
  // malformed id, a missing or foreign key (404), an inactive key, a rotate
  // that lost a race.
  "src/app/api/administrator/api-keys/[id]/rotate/route.ts": { statements: 77 },
  // GET's owner and org filters and the search; POST's refusals for a caller
  // with no app user, a bad body, and a missing, inactive or foreign owner.
  "src/app/api/administrator/api-keys/route.ts": { functions: 75 },
  // The search. GET runs only for a superadmin: the org admin's scope
  // predicate, the no-scope empty page and the status and org filters do not.
  "src/app/api/administrator/enterprise-apps/route.ts": { functions: 66 },
  // The search for six of the seven resources, the audit `created_at` range,
  // a multi-value user status filter, the roles org filter, a second page, and
  // both failure paths (the first page, and mid-stream).
  "src/app/api/administrator/export/[resource]/route.ts": {
    lines: 80,
    statements: 72,
    functions: 76,
  },
  // GET runs only for its refusals: no test lists a group's members, so the
  // list query (the search with it) never runs. POST's and DELETE's bad-body
  // and foreign-group 404 refusals do not run either.
  "src/app/api/administrator/groups/[id]/members/route.ts": { statements: 75, functions: 85 },
  // GET's org filter and search, and its row mapper (no test returns a row);
  // POST's refusals (a bad body, no org scope, a missing or foreign org) and a
  // superadmin's create in a named org.
  "src/app/api/administrator/groups/route.ts": {
    lines: 81,
    statements: 77,
    functions: 60,
    branches: 52,
  },
  // GET's status, organization and provider filters, and the search.
  "src/app/api/administrator/memberships/route.ts": { lines: 76, functions: 50 },
  // DELETE is invoked, but none of its refusals: a denied permission, a
  // rate-limited caller, a malformed invitation id, a missing or foreign org.
  "src/app/api/administrator/organizations/[id]/invitations/[invitationId]/route.ts": {
    branches: 60,
  },
  // GET's status and default filters and the search; POST's unparseable body,
  // and a create as the default org (the transaction callback never runs).
  "src/app/api/administrator/organizations/route.ts": {
    lines: 80,
    statements: 77,
    functions: 71,
  },
  // PATCH's and DELETE's refusals: a malformed id, a bad body, a missing
  // permission, one still in use (409) and one deleted concurrently.
  // tests/db/role-permission-delete-race.db.test.ts runs the in-use 409.
  "src/app/api/administrator/permissions/[id]/route.ts": {
    lines: 75,
    statements: 71,
    branches: 45,
  },
  // A malformed id, a missing source role, a taken `-copy` key (no test
  // returns a candidate, so neither the `map` callback nor the suffix loop
  // runs), an over-long key, and a duplicate key at insert (409).
  "src/app/api/administrator/roles/[id]/duplicate/route.ts": {
    lines: 77,
    statements: 70,
    functions: 75,
    branches: 61,
  },
  // A malformed id, and the search.
  "src/app/api/administrator/roles/[id]/members/route.ts": { lines: 81, functions: 50 },
  // GET's organization, scope and permission filters and the search (four
  // callbacks), and POST's unparseable body.
  "src/app/api/administrator/roles/route.ts": { functions: 63 },
  // A caller with no org scope (404), a user that is not deactivated (409),
  // and a failed Better Auth unban (502).
  "src/app/api/administrator/users/[id]/restore/route.ts": { branches: 61 },
  // A failed Better Auth session list or revoke-all (502, audited).
  "src/app/api/administrator/users/[id]/sessions/route.ts": { statements: 76, branches: 54 },
  // A filter-selected action's search, an unparseable body, and a filter that
  // selects nobody.
  "src/app/api/administrator/users/bulk/route.ts": { functions: 85 },
  // GET's status filter (one value or several) and the search (two
  // callbacks), and POST's unparseable body.
  "src/app/api/administrator/users/route.ts": { functions: 60 },
};
const flooredRouteFiles = readdirSync(join(ROOT, ROUTES_DIR), { recursive: true })
  .map((entry) => `${ROUTES_DIR}/${String(entry).replace(/\\/g, "/")}`)
  .filter((path) => path.endsWith("/route.ts"));
for (const path of Object.keys(ROUTE_FLOOR_EXCEPTIONS)) {
  // A path that names no route file would silently floor nothing; fail loudly.
  if (!flooredRouteFiles.includes(path)) throw new Error(`route floor: no route file at ${path}`);
}
const routeFloors = Object.fromEntries(
  flooredRouteFiles.map((path) => [
    literalGlob(path),
    { ...ROUTE_FLOOR, ...ROUTE_FLOOR_EXCEPTIONS[path] },
  ]),
);

/**
 * Vitest configuration.
 *
 * - Unit and pure-helper tests run in `node` for speed.
 * - Component tests under `tests/component/**` opt into the `jsdom`
 *   environment via the `// @vitest-environment jsdom` pragma at the top
 *   of each test file, so we don't pay the DOM cost for pure helpers.
 * - Coverage thresholds enforce the §29.2 gates.
 *
 * JSX is transformed by Vite 8's built-in Oxc transform with the automatic
 * runtime; no @vitejs/plugin-react is needed for Testing Library coverage of
 * our components. The option is `oxc` (I-12): Vitest injects its own `oxc`
 * options, so Vite 8 ignored the old `esbuild: { jsx: "automatic" }` block
 * with a "Both esbuild and oxc options were set" warning. The runtime is set
 * under `oxc` instead, which Vitest's `oxc.target` deep-merges with, and is
 * pinned here rather than inherited from tsconfig's `jsx`, which `next dev`
 * and `next build` write for Next's own needs.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      // `server-only` is a Next.js runtime guard; under Vitest we
      // stub it out so we can unit-test pure helpers that live in
      // `*.server.ts` files.
      "server-only": new URL("./tests/setup/server-only-shim.ts", import.meta.url).pathname,
      // Node ESM strict resolution does not auto-append `.js` to
      // `next/navigation` and `next/link` when reached transitively from
      // dependencies (e.g. next-intl/dist/esm/.../createNavigation.js).
      // CJS resolution works fine; these aliases match what Next exposes
      // so component tests can render LocaleLink etc. under jsdom.
      "next/navigation": "next/navigation.js",
      "next/link": "next/link.js",
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/vitest.setup.ts"],
    // `sdk/admin/client.test.ts` lives next to the hand-written SDK entry
    // point (review #240): importing the generated `runtime.ts` from under
    // tests/ would pull it into the root `tsc` program, where the generated
    // code trips `noImplicitOverride`; under sdk/ it is type-checked by the
    // SDK's own tsconfig (`pnpm sdk:admin:typecheck`) instead.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "sdk/admin/*.test.ts"],
    // tests/db/** are DB-backed (live Postgres) and run via vitest.db.config.ts
    // (`pnpm test:db`), not in this mocked-DB default run.
    exclude: ["tests/e2e/**", "tests/accessibility/**", "tests/db/**", "node_modules/**"],
    // Process-isolated forks (Vitest 4 default; pinned for clarity).
    pool: "forks",
    // --- Flaky-runner fix ---
    //
    // Root cause: within a SINGLE Vitest process, the SSR module runner
    // instantiates our heavy graph (Better Auth + Kysely + pg + next-intl)
    // per isolated file, and the shared Vite transform server races under
    // ANY concurrency — a module's named export reads back as `undefined`
    // ("(0, __vite_ssr_import__.getServerEnv) is not a function"), failing a
    // whole file. It is not a code cycle (`@/lib/env` only imports zod), the
    // corrupted transform is cached so `retry` can't recover it, and even 2
    // workers reproduce it. The only reliable cure is to remove concurrency
    // *inside a process*.
    //
    // So every Vitest process here runs SINGLE-WORKER (deterministic), and
    // parallelism comes from running independent SHARD PROCESSES — each with
    // its own transform server, so there is no shared race. `pnpm test`
    // drives the shards (scripts/test-shards.mjs): deterministic AND fast.
    // `pnpm test:serial` is the plain single-process fallback.
    //
    // F3: this setting applies to EVERY invocation, including `pnpm
    // test:coverage` — the CI quality gate, which cannot shard because coverage
    // must aggregate in a single process. So CI's coverage run is already
    // single-worker and race-safe; it does NOT bypass the mitigation. `retry`
    // is deliberately NOT configured: per the root cause above, the corrupted
    // transform is cached, so a retry just re-hits it — single-worker is the
    // only cure, not retries.
    maxWorkers: 1,
    // Headroom for the slowest module-init when several shards share a box.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // Force next-intl through Vite's transformer so that aliases like
        // `next/navigation` -> `next/navigation.js` apply inside the
        // dependency. Without this, Node ESM rejects the bare specifier.
        inline: ["next-intl"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/db/schema/generated.ts",
        // Page/layout files are exercised by E2E and route-integration
        // tests; they are excluded from unit coverage gates because they
        // primarily wire other components together.
        "src/app/**/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        // shadcn/ui primitives are generated and have their own upstream
        // tests. §29.2.3 explicitly exempts generated shadcn files.
        "src/components/ui/**",
        // Next.js runtime entry points (root layout, proxy edge handler,
        // i18n request adapter) are exercised through framework
        // integration paths, not directly testable in vitest.
        "src/app/(root)/layout.tsx",
        "src/app/(root)/page.tsx",
        "src/proxy.ts",
        "src/i18n/request.ts",
        // Migration / seed scripts are operational tooling, not runtime.
        "src/db/migrations/**",
        "src/db/seeds/**",
        // Pure barrel/type-only modules (only re-export types or define
        // interfaces with no executable code at runtime). §29.2.2
        // explicitly exempts pure barrel exports.
        "src/components/app-shell/shell-types.ts",
        "src/components/navigation/menu-types.ts",
        "src/db/schema/app-schema.ts",
        "next-env.d.ts",
      ],
      // Coverage RATCHET, toward the §29.2 spec target (90/90/90/82). Each
      // global threshold is the value `pnpm test:coverage` measures, rounded
      // down, less one point, and is only ever raised (docs/testing.md §4).
      //
      // F-125: the numbers had not moved since June (61/60/56/54) and sat more
      // than 20 points below the actuals, room for some 4,900 untested lines
      // before the gate tripped. Re-measured 2026-09-29 at 85.28 lines / 83.38
      // statements / 79.47 functions / 78.67 branches; the point of headroom is
      // about 190 untested lines. tests/unit/coverage-ratchet-config.test.ts
      // holds docs/testing.md §4's table to these numbers, so raise the two
      // together.
      thresholds: {
        lines: 84,
        statements: 82,
        functions: 78,
        branches: 77,
        // F-125: the `/api` route handlers together (see `ROUTE_TOTAL_FLOOR`).
        [`${API_ROUTES_DIR}/**/route.ts`]: ROUTE_TOTAL_FLOOR,
        // Per-file floors for the security-load-bearing modules (audit #18):
        // pinned a few points below current actuals so THESE specifically can
        // never silently regress, independent of the global ratchet. Raise as
        // coverage improves.
        "**/api-auth/v1-guard.server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 78,
        },
        "**/api-auth/scopes.ts": { lines: 95, statements: 95, functions: 95, branches: 95 },
        "**/admin/access-scope.server.ts": {
          lines: 88,
          statements: 90,
          functions: 82,
          branches: 90,
        },
        "**/admin/origin-guard.server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        // Credential resolution + session-auth surfaces (test-depth ratchet).
        // Floors sit a few points below measured actuals (resolve-caller /
        // ban-status / jwt are 100%); a regression in the code that decides
        // "who is this caller and can they act" fails CI on its own.
        "**/api-auth/resolve-caller.server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "**/api-auth/ban-status.server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "**/api-auth/jwt.server.ts": { lines: 95, statements: 95, functions: 90, branches: 88 },
        "**/api-auth/revocation.server.ts": {
          lines: 80,
          statements: 80,
          functions: 65,
          branches: 85,
        },
        // Credential codec + key/client stores (test-depth ratchet, branch
        // gap-close). Branch coverage was the whole point here — api-key.ts
        // 50→100, oauth-clients.server.ts 70→100, api-keys.server.ts 79→100 —
        // so these are pinned AT 100 (not a few points below): the tests are
        // fully deterministic (pure crypto + mocked-DB builders, no async
        // timing in the counted paths), and any new untested line/branch in a
        // module that mints/verifies machine credentials must fail CI, forcing
        // a test rather than silently sliding back. Raise the source, add the
        // test — never lower the floor.
        "**/api-auth/api-key.ts": { lines: 100, statements: 100, functions: 100, branches: 100 },
        "**/api-auth/api-keys.server.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        "**/api-auth/oauth-clients.server.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        "**/lib/auth-policy.server.ts": { lines: 90, statements: 90, functions: 85, branches: 82 },
        "**/lib/jwt-handoff.server.ts": { lines: 92, statements: 92, functions: 90, branches: 88 },
        "**/lib/auth-signup-provisioning.ts": {
          lines: 90,
          statements: 90,
          functions: 88,
          branches: 85,
        },
        "**/lib/sso.server.ts": { lines: 88, statements: 88, functions: 90, branches: 78 },
        // Review 2026-09-04 #122 (+ #27): the four authority modules with no
        // floor — the admin guard (incl. its untrusted-origin denial path), the
        // session guard (`getImpersonatorId`, the P0-1 marker), the tenant-switch
        // authority, and the self-service guard. Pinned a few points below the
        // measured actuals after the review's tests landed; raise, never lower.
        "**/lib/admin/permissions.server.ts": {
          lines: 90,
          statements: 90,
          functions: 95,
          branches: 85,
        },
        "**/lib/auth-guard.ts": { lines: 90, statements: 90, functions: 95, branches: 70 },
        "**/lib/active-org.server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 90,
        },
        "**/lib/account/guard.server.ts": {
          lines: 90,
          statements: 90,
          functions: 95,
          branches: 85,
        },
        // The pure impersonation-marker reader shared by both guards (review #28).
        "**/lib/impersonation.ts": { lines: 100, statements: 100, functions: 100, branches: 100 },
        // F-92: the docs/help viewers' authorization: the image route's gate
        // (session, membership, `shell.view`) and the per-document gate the
        // doc pages ask (`canViewDoc`, `getViewableDocument`). Pinned a few
        // points below the measured actuals (asset route 95/100/100/93,
        // catalog 91/93/93/92); raise, never lower.
        "**/lib/docs/asset-route.server.ts": {
          lines: 90,
          statements: 90,
          functions: 100,
          branches: 95,
        },
        "**/lib/docs/catalog.server.ts": { lines: 88, statements: 88, functions: 90, branches: 90 },
        // The shared Administrator grid. Not a security module — it is here
        // because it is the single render path behind all ~18 Administrator
        // list views, so a regression in it is the widest UI blast radius in
        // the app, and because it owns every TanStack call site: the table
        // library's failure modes across majors are render-time, not
        // type-time (detached prototype methods, a removed cell accessor, a
        // silently-ignored option key), which makes the tests that RENDER it
        // the only real detector. Pinned a few points below the measured
        // actuals (74 lines / 72 statements / 55 functions / 76 branches).
        // Raise as coverage improves; never lower.
        "**/_components/grid/data-grid.tsx": {
          lines: 70,
          statements: 68,
          functions: 52,
          branches: 72,
        },
        // F-42, F-125: one floor per route file under src/app (see
        // `routeFloors` above).
        ...routeFloors,
      },
    },
  },
});
