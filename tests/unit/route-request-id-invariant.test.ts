import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-29: every `src/app/api/**` route handler is exported through the
 * request-id wrapper for its surface (`src/lib/route-handler.server.ts`), or
 * its file carries a reviewed reason in EXEMPT.
 *
 * The correlation contract ("every response carries an `x-request-id` that
 * matches the audit rows, including a thrown 500") used to be kept per call
 * site, and most success paths plus every uncaught throw broke it while four
 * docs and the published OpenAPI description claimed otherwise. The wrapper
 * is the chokepoint; this scan is what keeps a NEW route from bypassing it.
 * A behavioural suite cannot catch the omission: a handler that returns
 * `NextResponse.json(...)` without the header works in every test that does
 * not look for it.
 *
 * Surface ⇒ wrapper, because the wrapper also renders a throw:
 *   - `api/v1/**`  → `withV1Route`    (RFC 7807 problem+json `internal_error`)
 *   - everything else → `withAdminRoute` (`{ error, message, requestId }`)
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");

const METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";
const METHOD_NAME = new RegExp(`^(?:${METHODS})$`);
/** An exported handler declaration: `export [async] function M` or `export const|let|var M`. */
const ANY_HANDLER = new RegExp(
  `export\\s+(?:(?:async\\s+)?function\\s+(${METHODS})\\b|(?:const|let|var)\\s+(${METHODS})\\b)`,
  "g",
);
/** `export * from "./x"` forwards whatever `./x` exports, which this scan never reads. */
const EXPORT_STAR = /export\s*\*/;

/**
 * Methods a file exports WITHOUT a declaration the scan above can inspect, each
 * a way to hand Next an unwrapped handler:
 *   - an export list: `export { GET }` (a local `async function GET`),
 *     `export { handler as GET }`, `export { GET } from "./other"`;
 *   - a destructuring export: `export const { GET, POST } = handlers`
 *     (`{ a: GET }` exports the binding `GET`).
 */
function hiddenHandlerExports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const spec of m[1]!.split(",")) {
      const exported = spec
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (METHOD_NAME.test(exported)) out.push(exported);
    }
  }
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const spec of m[1]!.split(",")) {
      const binding = spec.split(":").pop()!.split("=")[0]!.trim();
      if (METHOD_NAME.test(binding)) out.push(binding);
    }
  }
  return out;
}
const WRAPPER_IMPORT = /from\s+"@\/lib\/route-handler\.server"/;

// Why a route may answer without the wrapper. Keep each reason specific: an
// entry is a claim that no operator needs this route's id, or that stamping
// it would be wrong.
const EXEMPT: Record<string, string> = {
  "api/auth/[...all]/route.ts":
    "Better Auth catch-all: the plugin owns every response and its error shape; the route must not be wrapped",
  "api/health/route.ts":
    "liveness probe: no caller identity and no audit row; the orchestrator reads the status only",
  "api/health/ready/route.ts":
    "readiness probe: no caller identity and no audit row; probes parse `{ status, reason }` only",
  "api/metrics/route.ts":
    "Prometheus scrape (token-guarded text exposition): no audit row; the scraper reads the body only",
  "api/internal/outbox-drain/route.ts":
    "cron endpoint (CRON_SECRET): no human caller and no audit row; it catches and logs its own failure as a 500",
  "api/internal/mcp-registration-reap/route.ts":
    "cron endpoint (CRON_SECRET): no human caller and no audit row; it catches and logs its own failure as a 500",
  "api/security/csp-report/route.ts":
    "cookieless browser CSP report sink: always 204 and nothing reads its response headers",
  "api/docs/asset/[...path]/route.ts":
    "docs-viewer image stream: no audit row and no JSON envelope; the browser caches it (private, max-age=300)",
  "api/help/asset/[...path]/route.ts":
    "help-viewer image stream: no audit row and no JSON envelope; the browser caches it (private, max-age=300)",
  // Public, cacheable documents: a shared cache (CDN, reverse proxy) would
  // store the header with the body and replay one request's id to every later
  // client, the very collision review #224 warns about. None writes an audit
  // row. /api/v1/jwks.json answers its own key-loading 500 through
  // problemResponse (no-store), so that error still carries an id.
  "api/sso/jwks.json/route.ts":
    "public cacheable key set (public, max-age=300): a cached x-request-id would be replayed to other callers",
  "api/v1/jwks.json/route.ts":
    "public cacheable key set (public, max-age=300): a cached x-request-id would be replayed to other callers",
  "api/v1/openapi.json/route.ts":
    "public cacheable OpenAPI document (public, max-age=300): a cached x-request-id would be replayed to other callers",
  // Protocol-owned error shapes. Rendering a throw in the admin or v1 envelope
  // would put a non-protocol body on the wire; they need a protocol-shaped
  // wrapper of their own, tracked as an F-29 follow-up.
  "api/mcp/route.ts":
    "JSON-RPC 2.0 transport: errors are JSON-RPC error objects, not the admin/v1 envelope",
  "api/mcp/register/route.ts":
    "RFC 7591 registration: errors are `{ error, error_description }` (§3.2.2), not the admin/v1 envelope",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function rel(full: string): string {
  const norm = full.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/app/api/") + "/app/".length);
}

function wrapperFor(relPath: string): "withV1Route" | "withAdminRoute" {
  return relPath.startsWith("api/v1/") ? "withV1Route" : "withAdminRoute";
}

/** Every exported handler and whether it is wrapped with `wrapper`. */
function handlersOf(source: string, wrapper: string): Array<{ method: string; wrapped: boolean }> {
  return [...source.matchAll(ANY_HANDLER)].map((m) => {
    const method = (m[1] ?? m[2])!;
    const rest = source.slice(m.index! + m[0].length);
    const wrapped =
      m[2] !== undefined &&
      new RegExp(`^\\s*=\\s*${wrapper}\\(\\s*async\\s+function\\s+${method}\\b`).test(rest);
    return { method, wrapped };
  });
}

describe("F-29: every /api handler goes through the request-id wrapper (or is exempt)", () => {
  const routeFiles = walk(API_ROUTES_DIR).map((full) => ({
    rel: rel(full),
    source: readFileSync(full, "utf8"),
  }));

  it("discovers the whole API surface", () => {
    expect(routeFiles.length).toBeGreaterThan(80);
  });

  it("names only real route files in the exemption map", () => {
    for (const key of Object.keys(EXEMPT)) {
      expect(
        routeFiles.some((f) => f.rel === key),
        `EXEMPT names ${key}, which no longer exists: drop the stale entry`,
      ).toBe(true);
    }
  });

  it("recognises every handler export shape (regression guard for the scan itself)", () => {
    expect(handlersOf("export async function GET() {}", "withAdminRoute")).toEqual([
      { method: "GET", wrapped: false },
    ]);
    expect(handlersOf("export function POST() {}", "withAdminRoute")).toEqual([
      { method: "POST", wrapped: false },
    ]);
    expect(handlersOf("export const PUT = async () => new Response();", "withAdminRoute")).toEqual([
      { method: "PUT", wrapped: false },
    ]);
    // The wrong surface's wrapper renders a throw in the wrong envelope.
    expect(
      handlersOf("export const GET = withV1Route(async function GET(r) {});", "withAdminRoute"),
    ).toEqual([{ method: "GET", wrapped: false }]);
    expect(
      handlersOf(
        "export const DELETE = withAdminRoute(async function DELETE(\n  r: NextRequest,\n) {});",
        "withAdminRoute",
      ),
    ).toEqual([{ method: "DELETE", wrapped: true }]);
    expect(handlersOf("export let PATCH = async () => new Response();", "withAdminRoute")).toEqual([
      { method: "PATCH", wrapped: false },
    ]);
    // Exports the declaration scan cannot see must be caught by the other two.
    expect(hiddenHandlerExports("async function GET() {}\nexport { GET };")).toEqual(["GET"]);
    expect(hiddenHandlerExports("export { handler as POST, other };")).toEqual(["POST"]);
    expect(hiddenHandlerExports('export { GET, HEAD } from "./other";')).toEqual(["GET", "HEAD"]);
    expect(hiddenHandlerExports("export const { GET, x: POST } = handlers;")).toEqual([
      "GET",
      "POST",
    ]);
    // Renaming a method AWAY, or exporting a helper, hides no handler.
    expect(hiddenHandlerExports("export { GET as handler, csvEscape };")).toEqual([]);
    expect(EXPORT_STAR.test('export * from "./handlers";')).toBe(true);
    expect(EXPORT_STAR.test('export * as h from "./handlers";')).toBe(true);
  });

  it("wraps the whole admin and v1 surfaces (the walk is not vacuous)", () => {
    const wrapped = routeFiles
      .filter((f) => !(f.rel in EXEMPT))
      .flatMap((f) => handlersOf(f.source, wrapperFor(f.rel)).filter((h) => h.wrapped));
    // 130 handlers when F-29 landed; a count far below that means the scan
    // stopped matching the source, not that the surface shrank.
    expect(wrapped.length).toBeGreaterThan(100);
  });

  it.each(routeFiles.map((f) => [f.rel, f.source] as const))(
    "%s exports every handler through its surface's wrapper (or is exempt)",
    (relPath, source) => {
      if (relPath in EXEMPT) {
        expect(EXEMPT[relPath]!.length).toBeGreaterThan(0);
        return;
      }
      const wrapper = wrapperFor(relPath);
      // First, so a file whose ONLY handler hides behind one of these gets
      // this message rather than "exports no route handler".
      expect(
        hiddenHandlerExports(source),
        `${relPath} exports a handler through an export list or destructuring, which ` +
          `this scan cannot check for ${wrapper}; export the wrapped declaration instead`,
      ).toEqual([]);
      expect(
        EXPORT_STAR.test(source),
        `${relPath} uses \`export *\`, which this scan cannot read`,
      ).toBe(false);
      const handlers = handlersOf(source, wrapper);
      expect(handlers.length, `${relPath} exports no route handler`).toBeGreaterThan(0);
      const bare = handlers.filter((h) => !h.wrapped).map((h) => h.method);
      expect(
        bare,
        `${relPath} exports ${bare.join(", ")} without ${wrapper}. Export it as ` +
          `\`export const ${bare[0] ?? "GET"} = ${wrapper}(async function ${bare[0] ?? "GET"}(...) {...})\` ` +
          `so every response (and a thrown 500) carries the request id, or add a justified ` +
          `EXEMPT entry.`,
      ).toEqual([]);
      expect(WRAPPER_IMPORT.test(source)).toBe(true);
    },
  );
});
