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
        "src/app/layout.tsx",
        "src/app/page.tsx",
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
      // §29.2 minimum global gates. Per-file gates for security-critical
      // helpers (auth, account status, SSO, safe returnTo, provider org,
      // menu authorization) are enforced through dedicated tests; we
      // keep the global thresholds at the spec minimums.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 82,
      },
    },
  },
});
