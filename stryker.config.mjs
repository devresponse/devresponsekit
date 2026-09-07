// @ts-check
/**
 * Mutation testing (Stryker) — proves the tests actually ASSERT, not just
 * execute. A surviving mutant is a change to production code that NO test
 * caught: an unasserted invariant. We scope it to the SECURITY CORE's pure
 * algebra — the code where a surviving mutant means an unasserted
 * auth/injection guarantee — and ratchet the thresholds up over time.
 *
 * Run: `pnpm test:mutation` (Stryker, then the per-file floor check).
 *
 * SCOPE RULE (review #229): a module belongs here when it is PURE (no DB, no
 * network, no Next request plumbing) and its unit tests exercise it directly.
 * SQL-builder functions — e.g. grantable-permissions' permissionKeysFor* —
 * mock the DB in unit tests, so their mutants cannot be killed here; they
 * belong to the db-test suite and are deliberately out of scope.
 *
 * The GLOBAL `break` threshold is a floor for the whole run, which a large
 * well-covered file can mask. `scripts/check-mutation-floors.mjs` therefore
 * enforces a PER-FILE floor at each file's achieved score — the same shape as
 * the per-file coverage floors — so one module's assertions can never rot
 * behind another's.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  coverageAnalysis: "perTest",
  mutate: [
    // Scope algebra: which bearer scopes satisfy a route's requirement.
    "src/lib/api-auth/scopes.ts",
    // Open-redirect guard for post-auth returns.
    "src/lib/safe-return-to.ts",
    // Admin list-query parsing: sort/filter/pagination fed into SQL.
    "src/lib/admin/list-query.server.ts",
    // API-key codec: prefix/shape/hash of `drk_*` credentials (#229).
    "src/lib/api-auth/api-key.ts",
    // Trusted-origin parsing + the admin origin guard built on it (#229).
    "src/lib/trusted-origins.ts",
    "src/lib/admin/origin-guard.server.ts",
  ],
  // DELIBERATELY OUT OF SCOPE — `src/lib/jwt-handoff.server.ts` (the SSO
  // handoff codec, also proposed by #229). It instruments to 168 mutants on
  // top of this scope's 441, and every one of them re-runs jose Ed25519
  // sign/verify tests: measured, it more than doubles the run, which is
  // already the slowest advisory job in CI. Its assertions are covered by
  // dedicated unit suites (jwt-handoff*, sso-server) plus fast-check property
  // tests; revisit if the mutation job is ever parallelised (concurrency > 1).
  // One Stryker worker: each vitest run is already single-worker (see the
  // flaky-runner note in vitest.config.ts), so parallel vitest processes just
  // thrash the box for this small a mutate set.
  concurrency: 1,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Measured 2026-09-06 on this scope: 441 mutants, aggregate 89.80%
  // (api-key 97.67, scopes 95.45, origin-guard 94.12, list-query 89.69,
  // safe-return-to 76.74, trusted-origins 68.18). `break` gates the WHOLE run
  // below that with headroom, so a real drop in assertion strength fails it;
  // the per-file floors catch a drop the aggregate would hide.
  // `high`/`low` only color the report.
  thresholds: { high: 90, low: 80, break: 85 },
};
