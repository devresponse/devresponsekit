import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";

/**
 * Route ⇄ OpenAPI parity (audit #8/#17). The `/api/v1` OpenAPI document is
 * HAND-MAINTAINED and drives the served spec, the generated SDK, and the MCP
 * tool surface — but the drift job only checks the committed file is fresh, not
 * that it actually COVERS the real routes. This walks the route files and the
 * document and pins them together in BOTH directions, so a new/edited v1 route
 * that never made it into the spec (or a documented path with no route) fails
 * CI at the source rather than silently shipping a stale contract.
 */
const V1_DIR = join(process.cwd(), "src", "app", "api", "v1");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Routes that intentionally serve the discovery/spec surface itself rather than
// a documented data operation, so they are not OpenAPI paths.
const EXEMPT_PATHS = new Set(["/openapi.json"]);

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRoutes(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** src/app/api/v1/users/[id]/status/route.ts → /users/{id}/status */
function fileToApiPath(file: string): string {
  const segs = relative(V1_DIR, file)
    .split(sep)
    .slice(0, -1) // drop route.ts
    .map((s) => s.replace(/^\[(?:\.\.\.)?(\w+)\]$/, "{$1}"));
  return "/" + segs.join("/");
}

function methodsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return HTTP_METHODS.filter((m) =>
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src),
  );
}

const routes = walkRoutes(V1_DIR).map((f) => ({
  apiPath: fileToApiPath(f),
  methods: methodsOf(f),
}));

const doc = buildOpenApiDocument("https://x.example") as {
  paths: Record<string, Record<string, unknown>>;
};

describe("v1 route ⇄ OpenAPI parity (#8/#17)", () => {
  it("documents every HTTP method of every v1 route", () => {
    const missing: string[] = [];
    for (const r of routes) {
      if (EXEMPT_PATHS.has(r.apiPath)) continue;
      const item = doc.paths[r.apiPath];
      for (const m of r.methods) {
        if (!item || !item[m.toLowerCase()]) missing.push(`${m} ${r.apiPath}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("maps every documented path to a real route file", () => {
    const routePaths = new Set(routes.map((r) => r.apiPath));
    const orphaned = Object.keys(doc.paths).filter((p) => !routePaths.has(p));
    expect(orphaned).toEqual([]);
  });
});
