#!/usr/bin/env node
/**
 * Deterministic-AND-parallel test runner.
 *
 * Vitest's SSR transform server races under any in-process concurrency on
 * our heavy module graph (see the note in vitest.config.ts), so every
 * Vitest process here runs single-worker. To get parallelism back without
 * the shared-transform race, we run several INDEPENDENT shard processes —
 * each `vitest run --shard=i/N` has its own transform server, so there is
 * nothing to race. The result is reproducible on every run.
 *
 * Usage:
 *   node scripts/test-shards.mjs [extra vitest args…]
 *   TEST_SHARDS=6 node scripts/test-shards.mjs        # override shard count
 *
 * Exit code is non-zero if any shard fails. Each shard's output is buffered
 * and the full log of any FAILED shard is printed at the end.
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";

const passthrough = process.argv.slice(2);
const shardCount = (() => {
  const fromEnv = Number(process.env.TEST_SHARDS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
  // Default: scale with the box, capped. More shards balances our uneven
  // file weights (the Better-Auth integration files dominate) for a shorter
  // wall time. Determinism does not depend on this number — only speed does,
  // so small boxes safely fall to fewer shards (or one ≈ serial).
  return Math.min(6, Math.max(1, Math.floor(cpus().length / 2)));
})();

function runShard(index) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = ["exec", "vitest", "run", `--shard=${index}/${shardCount}`, ...passthrough];
    const child = spawn("pnpm", args, {
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary =
        out
          .replace(/\x1b\[[0-9;]*m/g, "")
          .split("\n")
          .find((l) => l.includes("Tests ") && (l.includes("passed") || l.includes("failed")))
          ?.trim() ?? "(no summary)";
      const ok = code === 0;
      console.log(
        `[shard ${index}/${shardCount}] ${ok ? "PASS" : "FAIL"} in ${seconds}s — ${summary}`,
      );
      resolve({ index, code, out, ok });
    });
  });
}

console.log(`Running ${shardCount} test shards (single-worker each)…`);
const results = await Promise.all(Array.from({ length: shardCount }, (_, i) => runShard(i + 1)));

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  for (const r of failed) {
    console.error(`\n──────── shard ${r.index}/${shardCount} output ────────`);
    console.error(r.out);
  }
  console.error(`\n${failed.length}/${shardCount} shard(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${shardCount} shards passed.`);
