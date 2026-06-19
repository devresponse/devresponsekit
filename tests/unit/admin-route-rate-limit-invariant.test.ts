import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Systemic guard: every mutating handler under `/api/administrator/**` AND
 * `/api/v1/**` must be rate-limited (docs/admin-manager.md §2.5 /
 * api-and-cli-guide §2.5).
 *
 * The contract — "all privileged mutations go through a token bucket" — had
 * silently drifted on the admin surface (~17 routes shipped unthrottled). A
 * point-in-time fix doesn't stop the NEXT route from forgetting; this scan
 * does, and it now covers the v1 surface too (MAPI-1) so a new versioned
 * mutation that forgets to throttle also fails CI.
 *
 * The check is count-based: a file must reference the rate-limit primitive at
 * least once per mutating handler it exports. The admin surface calls
 * `enforceRateLimit`; the v1 surface calls `enforceApiRateLimit` (and the
 * token endpoint the lower-level `consumeToken`). GET (read) handlers are not
 * required to throttle.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const ADMIN_ROUTES_DIR = join(SRC_DIR, "app", "api", "administrator");
const V1_ROUTES_DIR = join(SRC_DIR, "app", "api", "v1");

const MUTATING_HANDLER = /export async function (?:POST|PATCH|PUT|DELETE)\b/g;
const ADMIN_RATE_LIMIT_CALL = /enforceRateLimit\s*\(/g;
// v1 wraps the bucket as enforceApiRateLimit; the token endpoint calls the
// low-level consumeToken directly (per-credential/IP + a global floor).
const V1_RATE_LIMIT_CALL = /(?:enforceApiRateLimit|consumeToken)\s*\(/g;

const ADMIN_EXEMPT: Record<string, string> = {};
const V1_EXEMPT: Record<string, string> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function rel(full: string, anchor: string): string {
  const norm = full.replace(/\\/g, "/");
  const idx = norm.indexOf(anchor);
  return idx >= 0 ? norm.slice(idx) : norm;
}

function assertRateLimited(
  full: string,
  relPath: string,
  rateLimitCall: RegExp,
  exempt: Record<string, string>,
  primitive: string,
): void {
  const source = readFileSync(full, "utf8");
  const mutating = (source.match(MUTATING_HANDLER) ?? []).length;
  const limited = (source.match(rateLimitCall) ?? []).length;

  const norm = full.replace(/\\/g, "/");
  const key = Object.keys(exempt).find((k) => norm.endsWith(k));
  if (key) {
    expect((exempt[key] ?? "").length).toBeGreaterThan(0);
    return;
  }

  expect(
    limited >= mutating,
    `${relPath} exports ${mutating} mutating handler(s) (POST/PATCH/PUT/DELETE) but ` +
      `references ${primitive} ${limited} time(s). Every privileged mutation must go ` +
      `through the token bucket — add the ${primitive} call or a justified EXEMPT entry.`,
  ).toBe(true);
}

describe("every administrator mutation is rate-limited", () => {
  const routeFiles = walk(ADMIN_ROUTES_DIR);

  it("discovers the administrator route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [rel(f, "administrator"), f] as const))(
    "%s rate-limits every mutating handler",
    (relPath, full) => {
      assertRateLimited(full, relPath, ADMIN_RATE_LIMIT_CALL, ADMIN_EXEMPT, "enforceRateLimit");
    },
  );
});

describe("every /api/v1 mutation is rate-limited", () => {
  const routeFiles = walk(V1_ROUTES_DIR);

  it("discovers the v1 route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles.map((f) => [rel(f, "api/v1"), f] as const))(
    "%s rate-limits every mutating handler",
    (relPath, full) => {
      assertRateLimited(full, relPath, V1_RATE_LIMIT_CALL, V1_EXEMPT, "enforceApiRateLimit");
    },
  );
});
