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

/**
 * Array (repeatable) query parameters and `enum`s (F-34). The gateway sent
 * `["blocked", "suspended"]` as ONE comma-joined value, and validated only
 * that the argument was an array: `["bogus"]` passed, v1 dropped the unknown
 * status, and the agent got every user back as "the blocked ones".
 */
describe("validateToolArguments — arrays and enums (F-34)", () => {
  const listUsers = byName("listUsers")!;
  const listAuditEvents = byName("listAuditEvents")!;
  const listApiKeys = byName("listApiKeys")!;
  const createUser = byName("createUser")!;

  it("publishes each list's sort directives and filter vocabulary from the route contract", () => {
    const props = listUsers.inputSchema.properties as Record<
      string,
      { items?: { enum?: string[] } }
    >;
    expect(props["filter[status]"]?.items?.enum).toEqual([
      "active",
      "pending_approval",
      "blocked",
      "suspended",
      "deactivated",
    ]);
    expect(props.sort?.items?.enum).toEqual(
      expect.arrayContaining(["created_at.desc", "status.asc", "primary_email.desc"]),
    );
    const audit = listAuditEvents.inputSchema.properties as Record<
      string,
      { items?: { enum?: string[] } }
    >;
    expect(audit["filter[outcome]"]?.items?.enum).toEqual([
      "success",
      "denied",
      "error",
      "failure",
    ]);
    expect(audit["filter[event_type]"]?.items?.enum).toBeUndefined();
  });

  it("accepts several valid values for a repeatable parameter", () => {
    expect(
      validateToolArguments(listUsers, {
        "filter[status]": ["blocked", "suspended"],
        sort: ["created_at.desc", "status.asc"],
      }),
    ).toBeNull();
    expect(
      validateToolArguments(listAuditEvents, {
        "filter[outcome]": ["denied", "error"],
        "filter[event_type]": ["admin.user.created", "anything, with a comma"],
      }),
    ).toBeNull();
  });

  it("refuses an array item outside the enum, or of the wrong type", () => {
    expect(validateToolArguments(listUsers, { "filter[status]": ["bogus"] })).toBe(
      "Each item of argument `filter[status]` must be one of: active, pending_approval, blocked, suspended, deactivated.",
    );
    // The comma-joined form an agent might try is not a status either.
    expect(validateToolArguments(listUsers, { "filter[status]": ["blocked,suspended"] })).toMatch(
      /must be one of/,
    );
    expect(validateToolArguments(listUsers, { sort: ["created_at.down"] })).toMatch(
      /Each item of argument `sort` must be one of: created_at\.asc, created_at\.desc/,
    );
    expect(validateToolArguments(listAuditEvents, { "filter[event_type]": [5] })).toBe(
      "Each item of argument `filter[event_type]` must be of type string.",
    );
    expect(validateToolArguments(listAuditEvents, { "filter[event_type]": [{ a: 1 }] })).toBe(
      "Each item of argument `filter[event_type]` must be a string, number or boolean.",
    );
  });

  it("refuses a scalar outside its enum (query and body alike)", () => {
    expect(validateToolArguments(listApiKeys, { status: "bogus" })).toBe(
      "Argument `status` must be one of: active, revoked.",
    );
    expect(validateToolArguments(listApiKeys, { status: "revoked" })).toBeNull();
    expect(
      validateToolArguments(createUser, { email: "a@b.test", password: "x", role: "root" }),
    ).toBe("Argument `role` must be one of: admin, user.");
  });

  it("offers only explicit sort directions, and its description does not invite a bare field", () => {
    // The description used to say "A bare field name sorts ascending" next to
    // an enum without bare names, so an agent following it got -32602.
    for (const tool of [listUsers, listAuditEvents]) {
      const sort = (
        tool.inputSchema.properties as Record<
          string,
          { description?: string; items?: { enum?: string[] } }
        >
      ).sort!;
      expect(sort.description, tool.name).not.toMatch(/bare/i);
      expect(
        sort.items?.enum?.every((v) => /\.(asc|desc)$/.test(v)),
        tool.name,
      ).toBe(true);
    }
    expect(validateToolArguments(listUsers, { sort: ["status"] })).toMatch(/must be one of/);
  });

  it("refuses an empty string for an enum argument instead of reading it as absent", () => {
    // Pinned choice: "" is a value like any other. Dispatch sends it as-is, so
    // a non-enum one (`appUserId: ""`) reaches v1, which answers 400 exactly
    // as it would a raw `?appUserId=` (see mcp-route.test.ts).
    expect(validateToolArguments(listApiKeys, { status: "" })).toBe(
      "Argument `status` must be one of: active, revoked.",
    );
  });

  it("says in the description when a header parameter cannot be sent", () => {
    const setUserStatus = byName("setUserStatus")!;
    expect(setUserStatus.description).toContain(
      "The `If-Match` header cannot be sent through this tool; the call is made without it.",
    );
    expect(setUserStatus.inputSchema.properties).not.toHaveProperty("If-Match");
    expect(listUsers.description).not.toContain("header");
  });
});
