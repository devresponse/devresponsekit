import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallerKind } from "@/lib/api-auth/resolve-caller.server";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME_HTTP,
  buildAdminOpenApiDocument,
} from "@/lib/api-auth/openapi-admin";

/**
 * Structural guard for the admin OpenAPI document — the source for the
 * generated SDK under `sdk/admin/`. Codegen breaks on dangling `$ref`s or
 * missing operationIds, so we pin those here in addition to the byte-level
 * drift guard in `openapi-export.test.ts`. The later blocks pin the parts of
 * the contract that drifted from the handlers (review #193, #195, #196):
 * the documented credential kinds, the error responses, and — derived from
 * the route SOURCE — rate limits and list filters.
 */
type Operation = {
  operationId?: string;
  description?: string;
  /** Per-operation narrowing of the document-level `security` (see below). */
  security?: Array<Record<string, unknown[]>>;
  parameters?: Array<{ name: string; in: string; schema?: Record<string, unknown> }>;
  responses: Record<string, { $ref?: string }>;
};
type Doc = {
  openapi: string;
  servers: unknown;
  security: Array<Record<string, unknown[]>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
    parameters: Record<string, unknown>;
    responses: Record<
      string,
      { description: string; content: Record<string, { schema: { $ref: string } }> }
    >;
  };
  paths: Record<string, Record<string, Operation>>;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const doc = buildAdminOpenApiDocument("https://app.devresponse.com") as unknown as Doc;

/** Every (method, path, operation) triple in the document. */
function operations(): Array<{ method: string; path: string; op: Operation }> {
  const out: Array<{ method: string; path: string; op: Operation }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      if (item[method]) out.push({ method, path, op: item[method]! });
    }
  }
  return out;
}

describe("admin openapi document", () => {
  it("is a 3.1 document served under /api/administrator with cookie auth", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(JSON.stringify(doc.servers)).toContain("https://app.devresponse.com/api/administrator");
    expect(doc.components.securitySchemes.cookieSession).toBeTruthy();
  });

  it("gives every operation a unique operationId", () => {
    const ids: string[] = [];
    for (const { method, op } of operations()) {
      expect(op.operationId, `${method} missing operationId`).toBeTruthy();
      ids.push(op.operationId!);
    }
    expect(ids.length).toBeGreaterThanOrEqual(74);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of [
      "listUsers",
      "createOrganization",
      "exportResource",
      "bulkUserAction",
      "listMcpAgents",
      "approveMcpAgent",
      "updateMcpAgentScopes",
      "revokeMcpAgent",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("has no dangling $refs (codegen would fail otherwise)", () => {
    const components = doc.components;
    const defined = {
      schemas: new Set(Object.keys(components.schemas)),
      parameters: new Set(Object.keys(components.parameters)),
      responses: new Set(Object.keys(components.responses)),
    };
    const dangling: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") {
            const m = value.match(/^#\/components\/(schemas|parameters|responses)\/(.+)$/);
            if (!m || !defined[m[1] as keyof typeof defined].has(m[2]!)) dangling.push(value);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(doc);
    expect(dangling).toEqual([]);
  });
});

describe("documented security schemes ⇔ the credential kinds resolveCaller accepts (#193)", () => {
  // Exhaustive over `CallerKind` at COMPILE time: adding a fourth credential
  // kind to resolveCaller without deciding which documented scheme carries it
  // fails `pnpm typecheck`; removing a scheme fails the runtime check below.
  const SCHEME_FOR: Record<CallerKind, "cookieSession" | "bearerAuth"> = {
    session: "cookieSession",
    api_key: "bearerAuth",
    jwt: "bearerAuth",
  };

  it("the CallerKind union in source is exactly the kinds mapped here", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "lib", "api-auth", "resolve-caller.server.ts"),
      "utf8",
    );
    const union = /export type CallerKind = ([^;]+);/.exec(src)?.[1] ?? "";
    const kinds = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]!).sort();
    expect(kinds).toEqual(Object.keys(SCHEME_FOR).sort());
  });

  it("every mapped scheme is declared, and every declared scheme carries some kind", () => {
    const declared = Object.keys(doc.components.securitySchemes).sort();
    expect(declared).toEqual([...new Set(Object.values(SCHEME_FOR))].sort());
  });

  it("the document-level security is cookie OR bearer (two alternative requirements)", () => {
    expect(doc.security).toEqual([{ cookieSession: [] }, { bearerAuth: [] }]);
  });

  // `DELETE /users/{id}/impersonate` is the only admin route that does NOT go
  // through `requireAdminPermission`/`resolveCaller`: it applies
  // `checkTrustedOrigin` unconditionally (no `hasBearerCredential` bypass) and
  // then requires `getCurrentSession()`, so a bearer caller can only get
  // 403/401 there. The spec must narrow that ONE operation to cookie-only and
  // leave every other operation on the document default — an allow-list, not
  // "no operation may narrow", so that a future guard-bypassing route is
  // forced to declare itself here rather than silently inheriting a bearer
  // requirement the server does not honour (must-fix review of #193).
  const COOKIE_ONLY_OPERATIONS = new Set(["DELETE /users/{id}/impersonate"]);

  it("only the guard-bypassing operations narrow the document security, and they narrow to cookie-only", () => {
    const narrowed = new Map<string, unknown>();
    for (const { op, method, path } of operations()) {
      if (op.security !== undefined) narrowed.set(`${method.toUpperCase()} ${path}`, op.security);
    }
    expect([...narrowed.keys()].sort()).toEqual([...COOKIE_ONLY_OPERATIONS].sort());
    for (const [key, security] of narrowed) {
      expect(security, key).toEqual([{ cookieSession: [] }]);
    }
  });

  it("the cookie-only operations say why a bearer cannot authenticate there", () => {
    for (const { op, method, path } of operations()) {
      if (!COOKIE_ONLY_OPERATIONS.has(`${method.toUpperCase()} ${path}`)) continue;
      expect(String(op.description ?? ""), `${method} ${path}`).toMatch(/cookie session only/i);
    }
  });

  it("the allow-list matches the routes that skip requireAdminPermission", () => {
    // The spec's narrowing is only correct while the route really does bypass
    // the guard: pin the source fact rather than trusting the comment.
    const route = readFileSync(
      join(
        process.cwd(),
        "src",
        "app",
        "api",
        "administrator",
        "users",
        "[id]",
        "impersonate",
        "route.ts",
      ),
      "utf8",
    );
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).not.toMatch(/requireAdminPermission/);
    expect(del).toMatch(/checkTrustedOrigin\(request\)/);
    expect(del).toMatch(/getCurrentSession\(\)/);
  });

  it("bearerAuth is an HTTP bearer scheme whose description states the scope bound", () => {
    const bearer = doc.components.securitySchemes.bearerAuth!;
    expect(bearer.type).toBe("http");
    expect(bearer.scheme).toBe("bearer");
    expect(String(bearer.description)).toMatch(/scopes ∩ owner permissions/);
    expect(String(bearer.description)).toMatch(/exempt from the `Origin` guard/);
  });

  it("cookieSession names the __Secure- cookie and explains the http-dev name + signed value (#196)", () => {
    const cookie = doc.components.securitySchemes.cookieSession!;
    expect(cookie).toMatchObject({ type: "apiKey", in: "cookie", name: ADMIN_SESSION_COOKIE_NAME });
    expect(ADMIN_SESSION_COOKIE_NAME).toBe(`__Secure-${ADMIN_SESSION_COOKIE_NAME_HTTP}`);
    const description = String(cookie.description);
    expect(description).toContain("`__Secure-` prefix");
    expect(description).toContain(ADMIN_SESSION_COOKIE_NAME_HTTP);
    expect(description).toMatch(/SIGNED cookie value/);
    expect(description).toMatch(/`Origin` header/);
  });
});

describe("error responses (#195)", () => {
  it("every operation documents 401 (the guard answers it before anything else)", () => {
    const missing = operations()
      .filter(({ op }) => op.responses["401"]?.$ref !== "#/components/responses/Unauthorized")
      .map(({ method, path }) => `${method} ${path}`);
    expect(missing).toEqual([]);
  });

  it("Forbidden documents the untrusted_origin CSRF rejection as well as forbidden", () => {
    const forbidden = doc.components.responses.Forbidden!.description;
    expect(forbidden).toContain("`untrusted_origin`");
    expect(forbidden).toContain("`forbidden`");
    expect(forbidden).toMatch(/never returned to bearer callers/);
  });

  it("429 and 422 carry dedicated envelopes with the fields the handlers emit", () => {
    const { responses, schemas } = doc.components;
    expect(responses.RateLimited!.content["application/json"]!.schema.$ref).toBe(
      "#/components/schemas/RateLimitedError",
    );
    expect(responses.Unprocessable!.content["application/json"]!.schema.$ref).toBe(
      "#/components/schemas/UnprocessableError",
    );
    const extension = (name: string) =>
      (schemas[name]!.allOf as Array<Record<string, unknown>>)[1]!;
    expect(extension("RateLimitedError")).toMatchObject({ required: ["retryAfter"] });
    expect(extension("UnprocessableError")).toMatchObject({ required: ["ungrantableScopes"] });
    // Both extend the base envelope, which stays open for other `extra` fields.
    expect((schemas.RateLimitedError!.allOf as unknown[])[0]).toEqual({
      $ref: "#/components/schemas/AdminError",
    });
    expect(schemas.AdminError!.additionalProperties).toBe(true);
  });

  it("BulkUserRequest matches the route's Zod schema (strict, ids ≥ 1, status string|array)", () => {
    const bulk = doc.components.schemas.BulkUserRequest as {
      additionalProperties: boolean;
      properties: {
        ids: { type: string[]; minItems: number; maxItems: number };
        filters: { additionalProperties: boolean; properties: { status: { type: string[] } } };
      };
    };
    expect(bulk.additionalProperties).toBe(false);
    expect(bulk.properties.ids).toMatchObject({
      type: ["array", "string"],
      minItems: 1,
      maxItems: 500,
    });
    expect(bulk.properties.filters.additionalProperties).toBe(false);
    expect(bulk.properties.filters.properties.status.type).toEqual(["array", "string"]);
  });

  it("listAuditEvents documents the created_at range filter", () => {
    const names = doc.paths["/audit"]!.get!.parameters!.map((p) => p.name);
    expect(names).toContain("filter[created_at][from]");
    expect(names).toContain("filter[created_at][to]");
  });
});

/* -------------------------------------------------------------------------- */
/*  Source-derived contract (#195)                                            */
/* -------------------------------------------------------------------------- */

const ADMIN_DIR = join(process.cwd(), "src", "app", "api", "administrator");

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRoutes(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function fileToApiPath(file: string): string {
  const segs = relative(ADMIN_DIR, file)
    .split(sep)
    .slice(0, -1)
    .map((s) => s.replace(/^\[(?:\.\.\.)?(\w+)\]$/, "{$1}"));
  return "/" + segs.join("/");
}

/**
 * Splits a route file into its exported handler bodies, so a rate limit or a
 * filter allow-list is attributed to the METHOD that declares it (a file
 * whose POST is rate-limited says nothing about its GET).
 */
function handlerBodies(src: string): Array<{ method: string; body: string }> {
  const re = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  const starts = [...src.matchAll(re)].map((m) => ({ method: m[1]!, index: m.index! }));
  return starts.map((s, i) => ({
    method: s.method.toLowerCase(),
    body: src.slice(s.index, starts[i + 1]?.index ?? src.length),
  }));
}

/** String literals inside every `allowedFilters: [ ... ]` literal of `text`. */
function literalFilters(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/allowedFilters:\s*\[([^\]]*)\]/g)) {
    out.push(...[...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  }
  return out;
}

/** The export route allow-lists per resource in one map; take the union. */
function exportFilters(src: string): string[] {
  const block = /ALLOWED_FILTERS_BY_RESOURCE[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  return [...new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!))].filter(
    (name) => !/-/.test(name), // resource keys such as "enterprise-apps" are not filters
  );
}

describe("route source ⇒ documented contract (#195)", () => {
  const routes = walkRoutes(ADMIN_DIR)
    .filter((file) => fileToApiPath(file) !== "/metrics") // the one exempt route (#192)
    .map((file) => ({ file, apiPath: fileToApiPath(file), src: readFileSync(file, "utf8") }));

  it("the walk found the rate-limited and filtered handlers it is about to check", () => {
    const limited = routes.flatMap((r) =>
      handlerBodies(r.src).filter((h) => h.body.includes("enforceRateLimit(")),
    );
    const filtered = routes.filter((r) => literalFilters(r.src).length > 0);
    expect(limited.length).toBeGreaterThan(40);
    expect(filtered.length).toBeGreaterThan(12);
  });

  it("every handler that calls enforceRateLimit( documents a 429", () => {
    const missing: string[] = [];
    for (const { apiPath, src } of routes) {
      for (const { method, body } of handlerBodies(src)) {
        if (!body.includes("enforceRateLimit(")) continue;
        const op = doc.paths[apiPath]?.[method];
        if (op?.responses["429"]?.$ref !== "#/components/responses/RateLimited") {
          missing.push(`${method.toUpperCase()} ${apiPath}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every allowedFilters entry is a documented filter[<name>] (or [from]/[to] range) parameter", () => {
    const missing: string[] = [];
    for (const { apiPath, src } of routes) {
      for (const { method, body } of handlerBodies(src)) {
        const names = new Set([
          ...literalFilters(body),
          ...(apiPath === "/export/{resource}" ? exportFilters(src) : []),
        ]);
        if (names.size === 0) continue;
        const op = doc.paths[apiPath]?.[method];
        const params = new Set((op?.parameters ?? []).map((p) => p.name));
        for (const name of names) {
          const exact = params.has(`filter[${name}]`);
          const range = params.has(`filter[${name}][from]`) && params.has(`filter[${name}][to]`);
          if (!exact && !range) missing.push(`${method.toUpperCase()} ${apiPath} filter[${name}]`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("the mcp-agents list is the one filtered handler that parses via a helper — pinned by name", () => {
    // `parseMcpAgentListQuery` owns its allow-list in src/lib/mcp/agents.server.ts,
    // outside the route file, so the literal scan above cannot see it.
    const lib = readFileSync(join(process.cwd(), "src", "lib", "mcp", "agents.server.ts"), "utf8");
    const names = literalFilters(lib);
    expect(names).toEqual(["status"]);
    const params = doc.paths["/mcp-agents"]!.get!.parameters!.map((p) => p.name);
    expect(params).toContain("filter[status]");
  });
});
