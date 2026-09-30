import { describe, expect, it } from "vitest";
import {
  assertSupportedSchema,
  committedSpec,
  responseSchema,
  schemaViolations,
  type Surface,
} from "../helpers/openapi-response";

/**
 * The response-contract helper the route tests use (F-74). It is a validator
 * of our own, so it is pinned twice: it must implement every keyword the two
 * committed documents use (else a response could pass a check it never ran),
 * and each keyword must actually refuse what it should.
 */
const SURFACES: Surface[] = ["admin", "v1"];
const admin = committedSpec("admin");
const UUID = "11111111-1111-4111-8111-111111111111";

describe("the helper covers both committed documents", () => {
  it.each(SURFACES)("%s: every component schema uses only supported keywords", (surface) => {
    const { schemas } = committedSpec(surface).components;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(() => assertSupportedSchema(schema, name)).not.toThrow();
    }
  });

  it.each(SURFACES)("%s: every JSON response schema uses only supported keywords", (surface) => {
    let checked = 0;
    for (const [path, operations] of Object.entries(committedSpec(surface).paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          const content = (response as { content?: Record<string, { schema?: object }> }).content;
          const schema = content?.["application/json"]?.schema;
          if (!schema) continue;
          assertSupportedSchema(schema as Record<string, unknown>, `${method} ${path} ${status}`);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("refuses a keyword or format it does not implement, rather than skipping it", () => {
    expect(() => assertSupportedSchema({ type: "object", anyOf: [] })).toThrow(/anyOf/);
    expect(() => assertSupportedSchema({ items: { type: "string", format: "ipv4" } })).toThrow(
      /ipv4/,
    );
    expect(() => schemaViolations(admin, { not: { type: "string" } }, 1)).toThrow(/not/);
  });
});

describe("schemaViolations refuses what each keyword forbids", () => {
  it("required, const, type (with null) and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: { ok: { const: true }, note: { type: ["string", "null"] } },
      required: ["ok", "id"],
      additionalProperties: false,
    };
    expect(schemaViolations(admin, schema, { ok: true, id: 1, note: null })).toEqual([
      '$: unexpected property "id"',
    ]);
    expect(schemaViolations(admin, schema, { ok: false, note: 3 })).toEqual([
      '$: missing required "id"',
      "$.ok: expected true, got false",
      "$.note: expected string | null, got integer",
    ]);
    expect(schemaViolations(admin, schema, [])).toEqual(["$: expected object, got array"]);
  });

  it("formats, enum, lengths, pattern and numeric bounds", () => {
    expect(schemaViolations(admin, { type: "string", format: "uuid" }, UUID)).toEqual([]);
    expect(schemaViolations(admin, { type: "string", format: "uuid" }, "abc")).toHaveLength(1);
    const when = { type: "string", format: "date-time" };
    expect(schemaViolations(admin, when, "2026-09-29T10:00:00.123Z")).toEqual([]);
    expect(schemaViolations(admin, when, "2026-09-29")).toHaveLength(1);
    expect(schemaViolations(admin, { enum: ["a", "b"] }, "c")).toHaveLength(1);
    const text = { type: "string", minLength: 2, maxLength: 3, pattern: "^[a-z]+$" };
    expect(schemaViolations(admin, text, "ab")).toEqual([]);
    expect(schemaViolations(admin, text, "A")).toHaveLength(2);
    const count = { type: "integer", minimum: 0, maximum: 5 };
    expect(schemaViolations(admin, count, 6)).toEqual(["$: above 5"]);
    expect(schemaViolations(admin, count, 1.5)).toEqual(["$: expected integer, got number"]);
  });

  it("items, $ref, allOf and oneOf", () => {
    const list = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 };
    expect(schemaViolations(admin, list, ["a", 1])).toEqual(["$[1]: expected string, got integer"]);
    expect(schemaViolations(admin, list, [])).toEqual(["$: fewer than 1 items"]);
    const ok = { $ref: "#/components/schemas/Ok" };
    expect(schemaViolations(admin, ok, { ok: true })).toEqual([]);
    expect(schemaViolations(admin, ok, {})).toEqual(['$: missing required "ok"']);
    expect(schemaViolations(admin, { allOf: [ok, { required: ["id"] }] }, { ok: true })).toEqual([
      '$: missing required "id"',
    ]);
    const either = { oneOf: [{ type: "string" }, { type: "integer" }] };
    expect(schemaViolations(admin, either, 1)).toEqual([]);
    expect(schemaViolations(admin, either, true)).toHaveLength(1);
  });
});

describe("the two shapes F-74 found drifting, as the committed admin document declares them", () => {
  it("POST /organizations answers KeyCreated: `key` is required", () => {
    const schema = responseSchema("admin", "post", "/organizations", 201);
    expect(schemaViolations(admin, schema, { ok: true, id: UUID, slug: "acme" })).toEqual([
      '$: missing required "key"',
    ]);
  });

  it("DELETE /api-keys/{id} answers AdminApiKeyRevoked: `alreadyRevoked` is required", () => {
    const schema = responseSchema("admin", "delete", "/api-keys/{id}", 200);
    expect(schemaViolations(admin, schema, { ok: true })).toEqual([
      '$: missing required "alreadyRevoked"',
    ]);
  });

  it("an operation with no JSON answer for a status is an error, not a pass", () => {
    expect(() => responseSchema("admin", "post", "/organizations", 299)).toThrow(/declares no/);
  });
});
