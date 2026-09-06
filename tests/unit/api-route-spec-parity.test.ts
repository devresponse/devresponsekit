import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { buildAdminOpenApiDocument } from "@/lib/api-auth/openapi-admin";

/**
 * Route ⇄ OpenAPI parity (audit #8/#17; generalized to the admin surface in
 * review #192). Both OpenAPI documents are HAND-MAINTAINED: the `/api/v1` one
 * drives the served spec, the generated SDK and the MCP tool surface; the
 * `/api/administrator` one drives the committed admin SDK. The CI drift job
 * only checks the committed FILES are fresh, not that a document actually
 * COVERS the real routes — which is exactly how the four `mcp-agents` admin
 * operations shipped absent from the spec and the SDK. Each surface below
 * walks its route files and its document and pins them together in BOTH
 * directions, so a new/edited route that never made it into the spec (or a
 * documented path with no route) fails CI at the source.
 */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

interface Surface {
  name: string;
  /** Route root under src/app/api. */
  dir: string;
  doc: { paths: Record<string, Record<string, unknown>> };
  /** Route paths deliberately outside the spec, each with the reason. */
  exempt: Record<string, string>;
}

const SURFACES: Surface[] = [
  {
    name: "v1",
    dir: join(process.cwd(), "src", "app", "api", "v1"),
    doc: buildOpenApiDocument("https://x.example") as Surface["doc"],
    // `/openapi.json` used to be exempt here, but the v1 document models it
    // (`getOpenApi`), so the exemption was dead — the sanity check below
    // would now fail on it. Nothing on v1 is outside the spec.
    exempt: {},
  },
  {
    name: "administrator",
    dir: join(process.cwd(), "src", "app", "api", "administrator"),
    doc: buildAdminOpenApiDocument("https://x.example") as Surface["doc"],
    exempt: {
      // Backs the console home dashboard only: role-scoped, UI-shaped JSON
      // with no stable contract — deliberately not an SDK operation
      // (docs/api.md §6, sdk/admin/README.md). The ONLY exclusion.
      "/metrics": "console home dashboard only (UI-shaped, no SDK contract)",
    },
  },
];

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
function fileToApiPath(root: string, file: string): string {
  const segs = relative(root, file)
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

describe.each(SURFACES)("$name route ⇄ OpenAPI parity (#8/#17, #192)", (surface) => {
  const routes = walkRoutes(surface.dir).map((f) => ({
    apiPath: fileToApiPath(surface.dir, f),
    methods: methodsOf(f),
  }));
  const exempt = new Set(Object.keys(surface.exempt));

  it("walks a non-trivial route tree (the walker itself works)", () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.every((r) => r.methods.length > 0)).toBe(true);
  });

  it("documents every HTTP method of every route", () => {
    const missing: string[] = [];
    for (const r of routes) {
      if (exempt.has(r.apiPath)) continue;
      const item = surface.doc.paths[r.apiPath];
      for (const m of r.methods) {
        if (!item || !item[m.toLowerCase()]) missing.push(`${m} ${r.apiPath}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("maps every documented path to a real route file", () => {
    const routePaths = new Set(routes.map((r) => r.apiPath));
    const orphaned = Object.keys(surface.doc.paths).filter((p) => !routePaths.has(p));
    expect(orphaned).toEqual([]);
  });

  it("every exemption names a route that exists and is NOT in the spec", () => {
    // A stale exemption (route deleted, or later modeled) must be removed —
    // otherwise the list silently grows into a second, unchecked surface.
    const routePaths = new Set(routes.map((r) => r.apiPath));
    for (const p of exempt) {
      expect(routePaths.has(p), `${p} is exempt but has no route`).toBe(true);
      expect(surface.doc.paths[p], `${p} is exempt but IS documented`).toBeUndefined();
    }
  });
});

describe("administrator surface: the mcp-agents operations are modeled (#192)", () => {
  const doc = SURFACES[1]!.doc;
  it("documents list / approve / patch / delete with the console's contract", () => {
    const list = doc.paths["/mcp-agents"]?.get as {
      operationId: string;
      parameters: Array<{ name?: string; $ref?: string; schema?: { enum?: string[] } }>;
    };
    expect(list.operationId).toBe("listMcpAgents");
    // Shared params are `$ref`s into components.parameters; resolve their names.
    const shared = (
      buildAdminOpenApiDocument("https://x.example") as {
        components: { parameters: Record<string, { name: string }> };
      }
    ).components.parameters;
    const names = list.parameters.map(
      (p) => p.name ?? shared[p.$ref!.replace("#/components/parameters/", "")]!.name,
    );
    expect(names).toEqual(["page", "pageSize", "sort", "filter[status]"]);
    expect(list.parameters.at(-1)?.schema?.enum).toEqual(["pending", "active", "revoked"]);
    expect(
      (doc.paths["/mcp-agents/{id}/approve"]?.post as { operationId: string }).operationId,
    ).toBe("approveMcpAgent");
    expect((doc.paths["/mcp-agents/{id}"]?.patch as { operationId: string }).operationId).toBe(
      "updateMcpAgentScopes",
    );
    expect((doc.paths["/mcp-agents/{id}"]?.delete as { operationId: string }).operationId).toBe(
      "revokeMcpAgent",
    );
  });
});
