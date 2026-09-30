import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { calleeName, parseSource, pathBelow } from "../helpers/handler-scan";

/**
 * F-130: every 429 is counted and carries the refusing bucket's own
 * `Retry-After`, because no route builds one itself.
 *
 * The 429 used to be assembled in six places. The admin envelope
 * (`rateLimitDeniedResponse`), the token endpoint and the MCP transport each
 * counted theirs in `devresponsekit_rate_limit_denials_total`; the v1 mutation
 * limiter, the three `/api/v1/me/api-keys` routes and MCP registration did
 * not, so a flood of them left the documented abuse signal flat, and the key
 * routes answered a fixed `Retry-After: 2` whatever the bucket said. Each surface now has one
 * 429, built on `recordRateLimitDenial` (src/lib/http/rate-limit.server.ts):
 *
 *   - admin / first-party: `enforceRateLimit` / `enforceSharedRateLimit` →
 *     `rateLimitDeniedResponse`;
 *   - `/api/v1`: `enforceApiRateLimit`, or a direct bucket call answered with
 *     `rateLimitedProblemResponse`;
 *   - the MCP transport (JSON-RPC) and its RFC 7591 registration, whose
 *     protocol bodies are built in the route: PROTOCOL_429 below.
 *
 * So a route file may not spell the 429 itself: no `429` status and no
 * `"rate_limited"` code outside the files named here, and none may touch the
 * counter directly. A behavioural suite cannot catch the omission: a 429 the
 * metric misses works in every test that does not read the metric.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const APP_DIR = join(SRC_DIR, "app");
const API_DIR = join(APP_DIR, "api");

/** Routes that build a protocol-shaped 429, each through `recordRateLimitDenial`. */
const PROTOCOL_429: Record<string, string> = {
  "api/mcp/route.ts":
    "JSON-RPC 2.0: the 429 is error -32029 with data.retryAfter (the per-IP floor and the tool-call bucket)",
  "api/mcp/register/route.ts": "RFC 7591: the 429 is `{ error: temporarily_unavailable }`",
};

/** Routes that name the code for a reason other than answering a 429. */
const OTHER_EXEMPT: Record<string, string> = {
  "api/sso/consume/route.ts":
    "sends a BROWSER to the confirm page with ?error=rate_limited (a 303) for a denial enforceSharedRateLimit already counted; an API client gets that limiter's own 429",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/** Each place the file spells a 429 status or the `rate_limited` code, as `line: text`. */
function selfBuilt429s(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  visit(sf, (node) => {
    const is429 = ts.isNumericLiteral(node) && node.text === "429";
    const isCode = ts.isStringLiteral(node) && node.text === "rate_limited";
    if (!is429 && !isCode) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${line + 1}: ${node.parent.getText(sf).replace(/\s+/g, " ").slice(0, 120)}`);
  });
  return out;
}

function callsNamed(sf: ts.SourceFile, name: string): number {
  let n = 0;
  visit(sf, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === name) n += 1;
  });
  return n;
}

function mentionsCounter(sf: ts.SourceFile): boolean {
  let found = false;
  visit(sf, (node) => {
    if (ts.isIdentifier(node) && node.text === "rateLimitDenialsTotal") found = true;
  });
  return found;
}

describe("F-130: a route never builds its own 429", () => {
  const routeFiles = walk(API_DIR).map((full) => ({
    rel: pathBelow(APP_DIR, full),
    sf: parseSource(full, readFileSync(full, "utf8")),
  }));

  it("names only real files in the exemption maps", () => {
    for (const key of [...Object.keys(PROTOCOL_429), ...Object.keys(OTHER_EXEMPT)]) {
      expect(
        routeFiles.some((f) => f.rel === key),
        `${key} no longer exists`,
      ).toBe(true);
    }
  });

  it("recognises a hand-built 429 (regression guard for the scan itself)", () => {
    const scan = (text: string) => selfBuilt429s(parseSource("x.ts", text)).length;
    expect(
      scan('problemResponse("rate_limited", 429, request, { headers: { "Retry-After": "2" } });'),
    ).toBe(2);
    expect(scan("return new Response(body, { status: 429 });")).toBe(1);
    // A comment quoting the status is not a response.
    expect(scan("// answers 429 rate_limited\nreturn null;")).toBe(0);
  });

  it.each(routeFiles.map((f) => [f.rel, f.sf] as const))(
    "%s answers a 429 only through the shared helpers",
    (rel, sf) => {
      expect(
        mentionsCounter(sf),
        `${rel} increments rateLimitDenialsTotal itself; count through recordRateLimitDenial`,
      ).toBe(false);
      if (rel in OTHER_EXEMPT) return;
      if (rel in PROTOCOL_429) {
        expect(
          callsNamed(sf, "recordRateLimitDenial"),
          `${rel} builds a protocol 429; it must count and set Retry-After through recordRateLimitDenial`,
        ).toBeGreaterThan(0);
        return;
      }
      expect(
        selfBuilt429s(sf),
        `${rel} builds a 429 itself. Use enforceRateLimit / enforceSharedRateLimit ` +
          `(first-party), enforceApiRateLimit or rateLimitedProblemResponse (/api/v1), so ` +
          `the denial is counted and Retry-After is the bucket's own wait.`,
      ).toEqual([]);
    },
  );
});
