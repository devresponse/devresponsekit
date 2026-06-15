import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Systemic guard: every mutating handler under `/api/administrator/**` must
 * be rate-limited (docs/admin-manager.md §2.5 / api-and-cli-guide §2.5).
 *
 * The contract — "all admin mutations go through the per-actor token bucket"
 * — had silently drifted: ~17 privileged POST/PATCH/DELETE routes shipped
 * with no `enforceRateLimit`, leaving credential-issuing and tenant-mutating
 * surfaces open to post-auth flooding. A point-in-time fix doesn't stop the
 * NEXT route from forgetting; this scan does. A new admin route that exports
 * a mutating verb without calling `enforceRateLimit` fails CI here, forcing
 * the author to throttle it or add a justified exemption.
 *
 * The check is count-based: a file must reference `enforceRateLimit` at
 * least once per mutating handler it exports (each handler needs its own
 * call). GET (read) handlers are not required to throttle.
 */

const ADMIN_ROUTES_DIR = fileURLToPath(new URL("../../src/app/api/administrator", import.meta.url));

/**
 * Routes whose mutating handlers legitimately need NO per-actor rate limit,
 * each with a reason. Keep this list short and deliberate.
 */
const EXEMPT: Record<string, string> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const MUTATING_HANDLER = /export async function (?:POST|PATCH|PUT|DELETE)\b/g;
const RATE_LIMIT_CALL = /enforceRateLimit\s*\(/g;

describe("every administrator mutation is rate-limited", () => {
  const routeFiles = walk(ADMIN_ROUTES_DIR);

  it("discovers the administrator route handlers", () => {
    // Sanity check: if this drops to zero the glob/path is wrong and the
    // whole invariant would silently pass.
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [f.slice(f.indexOf("administrator")), f] as const))(
    "%s rate-limits every mutating handler",
    (rel, full) => {
      const source = readFileSync(full, "utf8");
      const mutating = (source.match(MUTATING_HANDLER) ?? []).length;
      const limited = (source.match(RATE_LIMIT_CALL) ?? []).length;

      const exemptKey = Object.keys(EXEMPT).find((k) => full.replace(/\\/g, "/").endsWith(k));
      if (exemptKey) {
        expect((EXEMPT[exemptKey] ?? "").length).toBeGreaterThan(0);
        return;
      }

      expect(
        limited >= mutating,
        `${rel} exports ${mutating} mutating handler(s) (POST/PATCH/PUT/DELETE) but ` +
          `references enforceRateLimit ${limited} time(s). Every administrator mutation ` +
          `must go through the per-actor token bucket: call enforceRateLimit(<key>, ` +
          `guard.betterAuthUserId, DEFAULT_ADMIN_MUTATION_LIMIT) right after the ` +
          `requireAdminPermission denial check — or add a justified EXEMPT entry.`,
      ).toBe(true);
    },
  );
});
