import { describe, expect, it } from "vitest";
import { buildAdminOpenApiDocument } from "@/lib/api-auth/openapi-admin";

/**
 * Structural guard for the admin OpenAPI document — the source for the
 * generated SDK under `sdk/admin/`. Codegen breaks on dangling `$ref`s or
 * missing operationIds, so we pin those here in addition to the byte-level
 * drift guard in `openapi-export.test.ts`.
 */
describe("admin openapi document", () => {
  const doc = buildAdminOpenApiDocument("https://app.devresponse.com") as Record<string, unknown>;

  it("is a 3.1 document served under /api/administrator with cookie auth", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(JSON.stringify(doc.servers)).toContain("https://app.devresponse.com/api/administrator");
    const schemes = (doc.components as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes.cookieSession).toBeTruthy();
  });

  it("gives every operation a unique operationId", () => {
    const paths = doc.paths as Record<string, Record<string, { operationId?: string }>>;
    const ids: string[] = [];
    for (const ops of Object.values(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(op.operationId, `${method} missing operationId`).toBeTruthy();
        ids.push(op.operationId!);
      }
    }
    expect(ids.length).toBeGreaterThanOrEqual(70);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of ["listUsers", "createOrganization", "exportResource", "bulkUserAction"]) {
      expect(ids).toContain(id);
    }
  });

  it("has no dangling $refs (codegen would fail otherwise)", () => {
    const components = doc.components as {
      schemas: Record<string, unknown>;
      parameters: Record<string, unknown>;
      responses: Record<string, unknown>;
    };
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
