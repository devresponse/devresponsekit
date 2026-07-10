// @ts-check
/**
 * Mutation testing (Stryker) — proves the tests actually ASSERT, not just
 * execute. A surviving mutant is a change to production code that NO test
 * caught: an unasserted invariant. We scope it to the SECURITY CORE's pure
 * algebra first — the code where a surviving mutant means an unasserted
 * auth/injection guarantee — and ratchet the `break` threshold up over time.
 *
 * Run: `pnpm test:mutation` (or `npx stryker run`).
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  coverageAnalysis: "perTest",
  // The PURE, unit-mutation-testable security algebra. (SQL-builder functions —
  // e.g. grantable-permissions' permissionKeysFor* — mock the DB in unit tests,
  // so their mutants can't be killed here; they belong to the db-test suite and
  // are deliberately out of this scope.)
  mutate: [
    "src/lib/api-auth/scopes.ts",
    "src/lib/safe-return-to.ts",
    "src/lib/admin/list-query.server.ts",
  ],
  // One Stryker worker: each vitest run is already single-worker (see the
  // flaky-runner note in vitest.config.ts), so parallel vitest processes just
  // thrash the box for this small a mutate set.
  concurrency: 1,
  reporters: ["clear-text", "progress"],
  // Measured baseline: ~89.5% on this scope (scopes.ts 95%, list-query 90%;
  // safe-return-to's remaining survivors are EQUIVALENT mutants — redundant
  // defense-in-depth guards a later guard still catches, which cannot be
  // killed and shouldn't be). `break` gates below it with headroom, so a real
  // drop in assertion strength fails the run; ratchet it up as survivors are
  // killed. `high`/`low` only color the report.
  thresholds: { high: 90, low: 80, break: 85 },
};
