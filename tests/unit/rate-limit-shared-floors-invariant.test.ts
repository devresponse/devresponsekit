import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Systemic guard for review #98: every PRE-AUTH rate-limit floor consumes
 * from the SHARED (Postgres-backed) bucket, never from the per-process one.
 *
 * The in-memory limiter is per lambda on Vercel, so a "deployment-wide" floor
 * taken from it multiplies by the instance count. The floors where that
 * matters are the ones an unauthenticated (or not-yet-trusted) caller can fan
 * out across invocations: the token endpoint, MCP registration, the CSP sink
 * and invitation acceptance. Routing them through `consumeSharedToken` /
 * `enforceSharedRateLimit` once is not enough — the next edit could put a
 * `consumeToken(rateLimitKey("x", "__global__"), …)` back — so this scan
 * greps the call sites on every run:
 *
 *   1. Each floor file imports the shared module and calls a shared primitive
 *      for its pre-auth budgets.
 *   2. No in-memory call in a floor file is keyed on `"__global__"` or on the
 *      trusted client IP (`clientIpKey(`): those are the pre-auth keys. The
 *      token endpoint's per-credential bucket (keyed on a VERIFIED credential)
 *      stays in memory and is not matched.
 *   3. Nowhere under `src/` is a `"__global__"` key consumed in memory — a new
 *      global floor in a new route must be shared from day one.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** route file (under src/app/api) → the shared primitive it must use. */
const PRE_AUTH_FLOORS: ReadonlyArray<[file: string, primitive: string]> = [
  ["v1/auth/token/route.ts", "consumeSharedToken"],
  ["mcp/register/route.ts", "consumeSharedToken"],
  ["security/csp-report/route.ts", "consumeSharedToken"],
  ["invitations/accept/route.ts", "enforceSharedRateLimit"],
];

const SHARED_MODULE = "@/lib/admin/rate-limit-shared.server";
const IN_MEMORY_CALL = /\b(?:consumeToken|enforceRateLimit)\s*\(/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The argument text of the call starting at `openParen` (balanced parens). */
function callArgs(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

function inMemoryCallArgs(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IN_MEMORY_CALL)) {
    out.push(callArgs(source, m.index + m[0].length - 1));
  }
  return out;
}

describe("review #98: pre-auth floors consume from the shared bucket", () => {
  it.each(PRE_AUTH_FLOORS)("%s uses %s for its pre-auth budget", (file, primitive) => {
    const source = readFileSync(join(SRC_DIR, "app", "api", file), "utf8");
    expect(source, `${file} must import ${SHARED_MODULE}`).toContain(`from "${SHARED_MODULE}"`);
    expect(
      (source.match(new RegExp(`\\b${primitive}\\s*\\(`, "g")) ?? []).length,
      `${file} must call ${primitive}( for its pre-auth floor`,
    ).toBeGreaterThan(0);
  });

  it.each(PRE_AUTH_FLOORS)(
    "%s never keys an in-memory bucket on __global__ or the client IP",
    (file) => {
      const source = readFileSync(join(SRC_DIR, "app", "api", file), "utf8");
      for (const args of inMemoryCallArgs(source)) {
        expect(
          args.includes("__global__") || args.includes("clientIpKey("),
          `${file}: in-memory consume keyed on a pre-auth identifier — use the shared primitive:\n  (${args.trim()})`,
        ).toBe(false);
      }
    },
  );

  it("the token endpoint still keeps its per-credential (post-verify) bucket in memory", () => {
    // Guards the scan itself: if this ever fails, the file has no in-memory
    // call left and the "never keys" assertion above is passing vacuously.
    const source = readFileSync(join(SRC_DIR, "app", "api", "v1/auth/token/route.ts"), "utf8");
    const args = inMemoryCallArgs(source);
    expect(args.some((a) => a.includes("api.token.credential"))).toBe(true);
  });

  it('no file under src/ consumes a "__global__" key from the in-memory bucket', () => {
    const offenders: string[] = [];
    for (const full of walk(SRC_DIR)) {
      const source = readFileSync(full, "utf8");
      if (!source.includes("__global__")) continue;
      for (const args of inMemoryCallArgs(source)) {
        if (args.includes("__global__")) offenders.push(full.replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("discovers the global floors it protects (the scan is not vacuous)", () => {
    const withGlobal = walk(SRC_DIR).filter((f) =>
      readFileSync(f, "utf8").includes('"__global__"'),
    );
    // token, register, csp-report — a shrink means a floor was dropped, not
    // that the surface got smaller.
    expect(withGlobal.length).toBeGreaterThanOrEqual(3);
  });
});
