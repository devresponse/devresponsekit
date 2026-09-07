// Per-file mutation-score floors (source review 2026-09-04, #229).
//
// Stryker's own `thresholds.break` is a single number for the WHOLE run: a
// large, well-killed file masks a small one whose assertions rotted. The
// coverage gate already uses per-file floors for exactly this reason; this
// script does the same for mutation score, reading the JSON report Stryker
// writes (`reports/mutation/mutation.json`).
//
// Run by `pnpm test:mutation` after `stryker run`.
//
// A floor is the score MEASURED when the file entered the ratchet, rounded
// down to a whole percent. Raise a floor when survivors are killed; NEVER
// lower one to make a run pass — a drop means a test stopped asserting.
import fs from "node:fs";
import path from "node:path";

const REPORT = path.join("reports", "mutation", "mutation.json");

/**
 * file -> minimum mutation score (%). Every mutated file must appear here, so
 * adding a file to `stryker.config.mjs` without a floor fails loudly instead
 * of joining the ratchet unmeasured.
 */
const FLOORS = {
  // Measured 2026-09-06 (441 mutants, aggregate 89.80%), floored to a whole
  // percent. `trusted-origins.ts` and `safe-return-to.ts` are the two real
  // gaps: the latter's survivors are EQUIVALENT mutants (redundant
  // defence-in-depth a later guard still catches), the former's are not —
  // kill them and raise the floor.
  "src/lib/api-auth/scopes.ts": 95,
  "src/lib/safe-return-to.ts": 76,
  "src/lib/admin/list-query.server.ts": 89,
  "src/lib/api-auth/api-key.ts": 97,
  "src/lib/trusted-origins.ts": 68,
  "src/lib/admin/origin-guard.server.ts": 94,
};

/** Detected = killed + timed out; undetected = survived + never covered. */
function scoreOf(mutants) {
  let detected = 0;
  let undetected = 0;
  for (const mutant of mutants) {
    if (mutant.status === "Killed" || mutant.status === "Timeout") detected++;
    else if (mutant.status === "Survived" || mutant.status === "NoCoverage") undetected++;
    // Ignored / CompileError mutants count towards neither, as in Stryker's
    // own mutation-score calculation.
  }
  const valid = detected + undetected;
  return { score: valid === 0 ? 100 : (detected / valid) * 100, detected, undetected };
}

if (!fs.existsSync(REPORT)) {
  console.error(
    `check-mutation-floors: ${REPORT} not found — run \`stryker run\` first ` +
      "(pnpm test:mutation does both).",
  );
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
const files = report.files ?? {};
const failures = [];
const rows = [];

for (const [rawPath, file] of Object.entries(files)) {
  const rel = rawPath.split(path.sep).join("/").replace(/^\.\//, "");
  const key = Object.keys(FLOORS).find((f) => rel.endsWith(f));
  const { score, detected, undetected } = scoreOf(file.mutants ?? []);
  rows.push({ rel: key ?? rel, score, detected, undetected });
  if (!key) {
    failures.push(`${rel}: mutated but has no floor in scripts/check-mutation-floors.mjs`);
    continue;
  }
  if (score + 1e-9 < FLOORS[key]) {
    failures.push(
      `${key}: mutation score ${score.toFixed(2)}% is below its floor of ${FLOORS[key]}% ` +
        `(${detected} detected / ${detected + undetected} valid mutants)`,
    );
  }
}

for (const key of Object.keys(FLOORS)) {
  if (!rows.some((r) => r.rel === key)) {
    failures.push(`${key}: has a floor but was not mutated — is it still in stryker.config.mjs?`);
  }
}

rows.sort((a, b) => a.rel.localeCompare(b.rel));
console.log("\nPer-file mutation scores (floor):");
for (const row of rows) {
  const floor = FLOORS[row.rel];
  console.log(
    `  ${row.score.toFixed(2).padStart(6)}%  (${floor === undefined ? "—" : `${floor}%`})  ${row.rel}`,
  );
}

if (failures.length > 0) {
  console.error(`\ncheck-mutation-floors: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\ncheck-mutation-floors: every mutated file is at or above its floor.");
