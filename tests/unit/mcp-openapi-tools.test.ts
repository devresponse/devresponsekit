import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { deriveMcpTools } from "@/lib/mcp/openapi-tools";

/**
 * Validates the tool deriver against the REAL OpenAPI document — the same
 * source that drives the served spec, `docs/openapi.json`, and the clients.
 */
const tools = deriveMcpTools(buildOpenApiDocument("https://x.example"));
const byName = (name: string) => tools.find((t) => t.name === name);

describe("deriveMcpTools (from the real OpenAPI document)", () => {
  it("covers the scoped operations and excludes the public/special ones", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["getMe", "listUsers", "createUser", "setUserStatus"]),
    );
    expect(names).toEqual(
      expect.arrayContaining(["listApiKeys", "listOauthClients", "rotateOauthClientSecret"]),
    );
    expect(names).not.toContain("issueToken");
    expect(names).not.toContain("getJwks");
    expect(names).not.toContain("getOpenApi");
    expect(tools.length).toBeGreaterThanOrEqual(15);
  });

  it("derives a dynamic path param as required", () => {
    const t = byName("getUser")!;
    expect(t.method).toBe("GET");
    expect(t.path).toBe("/users/{id}");
    expect(t.pathParams).toEqual(["id"]);
    expect(t.inputSchema.required).toContain("id");
    expect(t.readOnly).toBe(true);
  });

  it("derives query parameters for list operations", () => {
    const t = byName("listUsers")!;
    expect(t.queryParams).toEqual(expect.arrayContaining(["page", "pageSize", "q"]));
    expect(t.readOnly).toBe(true);
  });

  it("derives request-body properties for create/update operations", () => {
    const create = byName("createUser")!;
    expect(create.method).toBe("POST");
    expect(create.bodyProps).toEqual(expect.arrayContaining(["email", "password"]));
    expect(create.inputSchema.properties).toHaveProperty("email");
    expect(create.readOnly).toBe(false);

    const update = byName("updateOauthClient")!;
    expect(update.method).toBe("PATCH");
    expect(update.pathParams).toEqual(["id"]);
  });

  it("notes the required scope in the description when present", () => {
    expect(byName("listUsers")!.description).toContain("admin.users.read");
  });
});

describe("deriveMcpTools — unsupported body shapes fail loudly (audit #16)", () => {
  it("throws for a composed (allOf) request body rather than yielding an unusable tool", () => {
    const doc = {
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            summary: "Create a thing",
            security: [{ bearerAuth: ["admin.things.create"] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: { allOf: [{ $ref: "#/components/schemas/Thing" }] },
                },
              },
            },
            responses: {},
          },
        },
      },
      components: {
        schemas: { Thing: { type: "object", properties: { name: { type: "string" } } } },
      },
    };
    expect(() => deriveMcpTools(doc)).toThrow(/could not be flattened|createThing/);
  });
});
