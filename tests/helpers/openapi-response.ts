import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/**
 * Response-contract checks against the COMMITTED OpenAPI documents (F-74).
 *
 * Both documents are hand-maintained, and the admin SDK is generated from
 * `docs/openapi-admin.json`, so a handler that answers a shape the document
 * does not declare breaks every generated client while the drift test (which
 * only compares the files with their builders) stays green. Two did:
 * `POST /organizations` returned `{ ok, id, slug }` where the document
 * declares `KeyCreated { ok, id, key }`, and a first revoke on
 * `DELETE /api-keys/{id}` returned `{ ok }` where `AdminApiKeyRevoked`
 * requires `alreadyRevoked`. A route test asserts its answer with
 * {@link expectResponseMatchesSpec} to pin it to the document.
 *
 * A validator of our own, not ajv: ajv reaches `node_modules` only as another
 * package's dependency, in three versions, and is not ours to import. It
 * covers the JSON Schema keywords the two documents use and THROWS on any
 * other, so a document that starts using one fails here instead of passing
 * unchecked (tests/unit/openapi-response-helper.test.ts walks both documents).
 */

export type Surface = "admin" | "v1";
type Schema = Record<string, unknown>;
interface OpenApiDocument {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  components: { schemas: Record<string, Schema> };
}

const SPEC_FILES: Record<Surface, string> = {
  admin: join(process.cwd(), "docs", "openapi-admin.json"),
  v1: join(process.cwd(), "docs", "openapi.json"),
};
const specs = new Map<Surface, OpenApiDocument>();

/** The committed document for `surface` (read once). */
export function committedSpec(surface: Surface): OpenApiDocument {
  let doc = specs.get(surface);
  if (!doc) {
    doc = JSON.parse(readFileSync(SPEC_FILES[surface], "utf8")) as OpenApiDocument;
    specs.set(surface, doc);
  }
  return doc;
}

/** Keywords that only annotate: they never make a value invalid. */
const ANNOTATIONS = new Set(["description", "title", "example", "examples", "deprecated"]);
/** Keywords {@link schemaViolations} checks. */
const ASSERTIONS = new Set([
  "$ref",
  "allOf",
  "oneOf",
  "type",
  "const",
  "enum",
  "format",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
]);

const FORMATS: Record<string, (value: string) => boolean> = {
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  "date-time": (v) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(v) &&
    !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]+@[^\s@]+$/.test(v),
  uri: (v) => URL.canParse(v),
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function resolveRef(doc: OpenApiDocument, ref: string): Schema {
  const name = /^#\/components\/schemas\/([^/]+)$/.exec(ref)?.[1];
  const schema = name === undefined ? undefined : doc.components.schemas[name];
  if (!schema) throw new Error(`openapi-response: unresolvable $ref ${ref}`);
  return schema;
}

/**
 * Every way `value` breaks `schema`, as `<path>: <reason>` lines; empty when
 * it conforms. Throws on a keyword this validator does not implement.
 */
export function schemaViolations(
  doc: OpenApiDocument,
  schema: Schema,
  value: unknown,
  at = "$",
): string[] {
  const unknown = Object.keys(schema).filter((k) => !ASSERTIONS.has(k) && !ANNOTATIONS.has(k));
  if (unknown.length > 0) {
    throw new Error(`openapi-response: unsupported keyword(s) ${unknown.join(", ")} at ${at}`);
  }
  const out: string[] = [];
  const sub = (s: unknown, v: unknown, path: string) => schemaViolations(doc, s as Schema, v, path);

  if (typeof schema.$ref === "string") out.push(...sub(resolveRef(doc, schema.$ref), value, at));
  for (const part of (schema.allOf as Schema[] | undefined) ?? [])
    out.push(...sub(part, value, at));
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter((s) => sub(s, value, at).length === 0).length;
    if (matching !== 1) out.push(`${at}: matches ${matching} of the oneOf branches, not 1`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [String(schema.type)];
    if (!types.some((t) => matchesType(value, t))) {
      // A value of the wrong type makes every other check below noise.
      return [...out, `${at}: expected ${types.join(" | ")}, got ${typeOf(value)}`];
    }
  }
  if ("const" in schema && value !== schema.const) {
    out.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    const check = typeof schema.format === "string" ? FORMATS[schema.format] : undefined;
    if (typeof schema.format === "string" && !check) {
      throw new Error(`openapi-response: unsupported format ${schema.format} at ${at}`);
    }
    if (check && !check(value))
      out.push(`${at}: ${JSON.stringify(value)} is not a ${schema.format}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      out.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      out.push(`${at}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      out.push(`${at}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      out.push(`${at}: below ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      out.push(`${at}: above ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      out.push(`${at}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      out.push(`${at}: more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => out.push(...sub(schema.items, item, `${at}[${i}]`)));
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(obj, key)) out.push(`${at}: missing required "${key}"`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(properties, key)) {
        out.push(...sub(properties[key], v, `${at}.${key}`));
      } else if (schema.additionalProperties === false) {
        out.push(`${at}: unexpected property "${key}"`);
      } else if (typeof schema.additionalProperties === "object") {
        out.push(...sub(schema.additionalProperties, v, `${at}.${key}`));
      }
    }
  }
  return out;
}

/**
 * Throws unless {@link schemaViolations} implements every keyword and format
 * in `schema` and each of its subschemas, and every `pattern` compiles.
 * `schemaViolations` itself only reaches the subschemas a value leads it to.
 */
export function assertSupportedSchema(schema: Schema, at = "$"): void {
  const unknown = Object.keys(schema).filter((k) => !ASSERTIONS.has(k) && !ANNOTATIONS.has(k));
  if (unknown.length > 0) {
    throw new Error(`openapi-response: unsupported keyword(s) ${unknown.join(", ")} at ${at}`);
  }
  if (typeof schema.format === "string" && !Object.hasOwn(FORMATS, schema.format)) {
    throw new Error(`openapi-response: unsupported format ${schema.format} at ${at}`);
  }
  if (typeof schema.pattern === "string") new RegExp(schema.pattern, "u");
  const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
  for (const [key, s] of Object.entries(properties)) assertSupportedSchema(s, `${at}.${key}`);
  for (const key of ["items", "additionalProperties"]) {
    const s = schema[key];
    if (typeof s === "object" && s !== null) assertSupportedSchema(s as Schema, `${at}.${key}`);
  }
  for (const key of ["allOf", "oneOf"]) {
    const list = schema[key];
    if (Array.isArray(list)) {
      list.forEach((s, i) => assertSupportedSchema(s as Schema, `${at}.${key}[${i}]`));
    }
  }
}

/** The `application/json` schema `method path` declares for `status`. */
export function responseSchema(
  surface: Surface,
  method: string,
  path: string,
  status: number,
): Schema {
  const operation = committedSpec(surface).paths[path]?.[method.toLowerCase()];
  const response = operation?.responses?.[String(status)] as
    { content?: Record<string, { schema?: Schema }> } | undefined;
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) {
    throw new Error(`openapi-response: ${surface} ${method} ${path} declares no JSON ${status}`);
  }
  return schema;
}

/**
 * Asserts `res` is a status the operation declares and that its JSON body
 * conforms to that status's schema in the committed document. Returns the
 * body. Reads a clone, so the caller may still read `res`.
 */
export async function expectResponseMatchesSpec(
  res: Response,
  surface: Surface,
  method: string,
  path: string,
): Promise<unknown> {
  const body: unknown = await res.clone().json();
  const schema = responseSchema(surface, method, path, res.status);
  const label = `${surface} ${method.toUpperCase()} ${path} ${res.status}`;
  expect(schemaViolations(committedSpec(surface), schema, body), label).toEqual([]);
  return body;
}
