import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { deriveMcpTools, pathParamRejection, validateToolArguments } from "@/lib/mcp/openapi-tools";

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

/**
 * Argument validation (review #54). The generated tools advertise an
 * `inputSchema` with `additionalProperties: false`, but nothing enforced it:
 * unknown keys were dropped silently, wrong types were stringified into the
 * URL, and — the security-relevant half — an empty or dotted PATH param
 * re-routed the self-fetch. `/users/{id}` with `id: ""` becomes `/users/`,
 * which the trailing-slash redirect resolves to the *collection* (listUsers);
 * `id: ".."` walks up to `/api/v1/`. `encodeURIComponent` leaves `.`
 * untouched, so nothing downstream caught either.
 */
describe("validateToolArguments (review #54)", () => {
  const getUser = byName("getUser")!;
  const listUsers = byName("listUsers")!;
  const createUser = byName("createUser")!;

  it("accepts a well-formed call", () => {
    expect(
      validateToolArguments(getUser, { id: "11111111-1111-4111-8111-111111111111" }),
    ).toBeNull();
    expect(validateToolArguments(listUsers, { page: 2, q: "ada" })).toBeNull();
    expect(validateToolArguments(createUser, { email: "a@b.test", password: "x" })).toBeNull();
  });

  it("rejects an unknown argument (additionalProperties: false, now enforced)", () => {
    expect(validateToolArguments(listUsers, { nope: 1 })).toMatch(/Unknown argument/);
  });

  it("rejects a missing required argument", () => {
    expect(validateToolArguments(getUser, {})).toMatch(/Missing required argument/);
  });

  it("rejects a declared-type mismatch", () => {
    expect(validateToolArguments(listUsers, { page: "two" })).toMatch(/must be of type/);
    expect(validateToolArguments(listUsers, { q: 5 })).toMatch(/must be of type/);
    expect(validateToolArguments(createUser, { email: "a@b.test", password: [] })).toMatch(
      /must be of type/,
    );
  });

  it("REFUSES a path param that would re-route the request", () => {
    // The re-routing set: empty / whitespace collapses the segment; "." and
    // ".." are resolved by the URL parser; a separator escapes the segment.
    for (const id of ["", "   ", ".", "..", "a/b", "..%2fadmin", "back\\slash", "%2e%2e"]) {
      expect(validateToolArguments(getUser, { id }), JSON.stringify(id)).toMatch(/Path parameter/);
    }
    const withNul = `x${String.fromCharCode(0)}y`;
    expect(validateToolArguments(getUser, { id: withNul })).toMatch(/control characters/);
    expect(validateToolArguments(getUser, { id: 5 })).toMatch(/must be of type|must be a string/);
  });

  it("still accepts an ordinary id (the guard is not a blanket refusal)", () => {
    expect(pathParamRejection("id", "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(pathParamRejection("id", "key_abc-123")).toBeNull();
  });
});
