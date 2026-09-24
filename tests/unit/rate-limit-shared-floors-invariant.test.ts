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
 *
 * F-18 added the ORDER: a deployment-wide floor may only be charged for a
 * request its per-source (per-IP) bucket admitted, or one IP spends everyone's
 * budget with requests it is itself refused. All three routes had consumed the
 * global token first. The order now lives in ONE helper,
 * `consumeSourceThenGlobal` (src/lib/admin/rate-limit-tiered.server.ts), and:
 *
 *   4. `__global__` is spelled nowhere under `src/` but that helper, so no
 *      route can build a global key and consume it itself, before (or
 *      without) its per-source bucket, whether it passes the key to
 *      `consumeSharedToken` inline or through a variable.
 *   5. The helper itself consumes from the shared bucket.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

const SHARED_MODULE = "@/lib/admin/rate-limit-shared.server";
const TIERED_MODULE = "@/lib/admin/rate-limit-tiered.server";
const TIERED_FILE = join(SRC_DIR, "lib", "admin", "rate-limit-tiered.server.ts");
const TIERED_PRIMITIVE = "consumeSourceThenGlobal";

/** route file (under src/app/api) → the module and shared primitive it must use. */
const PRE_AUTH_FLOORS: ReadonlyArray<[file: string, module: string, primitive: string]> = [
  // Per-IP bucket + global floor, in that order (F-18).
  ["v1/auth/token/route.ts", TIERED_MODULE, TIERED_PRIMITIVE],
  ["mcp/register/route.ts", TIERED_MODULE, TIERED_PRIMITIVE],
  ["security/csp-report/route.ts", TIERED_MODULE, TIERED_PRIMITIVE],
  // One per-user bucket, no global floor.
  ["invitations/accept/route.ts", SHARED_MODULE, "enforceSharedRateLimit"],
];
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
  it.each(PRE_AUTH_FLOORS)("%s uses %s's %s for its pre-auth budget", (file, module, primitive) => {
    const source = readFileSync(join(SRC_DIR, "app", "api", file), "utf8");
    expect(source, `${file} must import ${module}`).toContain(`from "${module}"`);
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

  it("the tiered helper consumes both of its tiers from the shared bucket", () => {
    const source = readFileSync(TIERED_FILE, "utf8");
    expect(source).toContain(`from "${SHARED_MODULE}"`);
    expect((source.match(/\bconsumeSharedToken\s*\(/g) ?? []).length).toBe(2);
    expect(inMemoryCallArgs(source)).toEqual([]);
  });
});

describe("F-18: a global floor is charged only after its per-source bucket admits", () => {
  it('"__global__" is spelled nowhere under src/ but the tiered helper', () => {
    // A route that spells the global key can consume it itself, and taking it
    // first is exactly the bug: every request its IP bucket then refused had
    // already spent a deployment-wide token. Go through consumeSourceThenGlobal.
    const spelledIn = walk(SRC_DIR)
      .filter((f) => readFileSync(f, "utf8").includes("__global__"))
      .map((f) => f.replace(/\\/g, "/"));
    expect(spelledIn).toEqual([TIERED_FILE.replace(/\\/g, "/")]);
  });

  it("discovers the tiered floors it protects (the scan is not vacuous)", () => {
    const callers = walk(join(SRC_DIR, "app")).filter((f) =>
      new RegExp(`\\b${TIERED_PRIMITIVE}\\s*\\(`).test(readFileSync(f, "utf8")),
    );
    // token, register, csp-report — a shrink means a floor was dropped, not
    // that the surface got smaller.
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });
});
