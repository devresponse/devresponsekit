import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vitest configuration.
 *
 * - Unit and pure-helper tests run in `node` for speed.
 * - Component tests under `tests/component/**` opt into the `jsdom`
 *   environment via the `// @vitest-environment jsdom` pragma at the top
 *   of each test file, so we don't pay the DOM cost for pure helpers.
 * - Coverage thresholds enforce the §29.2 gates.
 *
 * JSX is transformed natively by esbuild (the default Vitest pipeline);
 * we intentionally do not depend on @vitejs/plugin-react because Vitest 4
 * is locked to Vite 7 while plugin-react@6 requires Vite 8. Native esbuild
 * is sufficient for Testing Library coverage of our components.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  esbuild: {
    jsx: "automatic",
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
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "tests/accessibility/**", "node_modules/**"],
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
      // Coverage RATCHET. The §29.2 spec target (90/90/90/82) was never
      // enforced — there was no CI — so the thresholds are pinned just
      // below today's measured values: any regression fails CI, and the
      // numbers MUST only ever be raised as coverage improves, until they
      // reach the spec minimums. See docs/security-test-coverage-plan.md.
      //
      // Phases 1-5 of that plan lifted the global floor from 38/36 to the
      // values below: the cross-tenant isolation matrix (Phase 1), the
      // bulk/Better-Auth server helpers (Phase 2), the v1 machine-API
      // surface (Phase 3), schema/input-validation (Phase 4), and the
      // residual primitive branches (Phase 5). src/lib/admin is now ~92%
      // line. Keep raising these toward the §29.2 spec minimums.
      thresholds: {
        lines: 52,
        statements: 51,
        functions: 46,
        branches: 48,
      },
    },
  },
});
