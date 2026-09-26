/**
 * Derives the MCP tool surface from the app's own OpenAPI 3.1 document
 * (`buildOpenApiDocument`) — the single source of truth that also drives the
 * served spec, the committed `docs/openapi.json`, and the generated clients.
 * A new scoped `/api/v1` operation becomes an MCP tool for free.
 *
 * Pure (no `server-only`): the input is the document object, so this is
 * trivially unit-testable against the real spec. Dispatch (self-fetch) lives
 * in `tools.server.ts`. See docs/design-mcp-agent-gateway.md §11.
 */
import type { McpInputSchema } from "./protocol";

/** Public/special operations that are never exposed as agent tools. */
const EXCLUDED_OPERATION_IDS = new Set(["issueToken", "getJwks", "getOpenApi"]);
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface GeneratedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: McpInputSchema;
  method: string;
  /** OpenAPI path template, e.g. `/users/{id}`. */
  path: string;
  /** Argument names that fill `{…}` path segments. */
  pathParams: string[];
  /** Argument names sent as query parameters. */
  queryParams: string[];
  /** Argument names sent in the JSON request body. */
  bodyProps: string[];
  readOnly: boolean;
}

interface OpenApiParam {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
  $ref?: string;
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParam[];
  requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
}
interface OpenApiDoc {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  security?: unknown[];
  components?: {
    parameters?: Record<string, OpenApiParam>;
    schemas?: Record<
      string,
      { properties?: Record<string, Record<string, unknown>>; required?: string[] }
    >;
  };
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? "";
}

/**
 * Path-parameter values that must never reach the self-fetch (review #54).
 *
 * A path param is substituted into an OpenAPI template (`/users/{id}`) and
 * the result is parsed by `new URL(...)`, which RESOLVES dot segments. So an
 * empty value collapses `/users/{id}` to `/users/` — which the trailing-slash
 * redirect turns into the *collection* endpoint (`listUsers`) — and `.` /
 * `..` walk the request to a different route entirely. Neither is a typo the
 * v1 API would catch: the caller ends up at an endpoint it did not name, with
 * the tool's own scope. `encodeURIComponent` does NOT encode `.`, so nothing
 * downstream stops this either.
 *
 * Refused: empty/whitespace, `.`, `..`, anything containing a separator
 * (`/`, `\`) or a percent-encoded separator or dot (`%2f`, `%5c`, `%2e`), and
 * any control character.
 */
const ENCODED_SEPARATOR_RE = /%(2f|5c|2e)/i;
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function pathParamRejection(name: string, value: unknown): string | null {
  if (typeof value !== "string") {
    return `Path parameter \`${name}\` must be a string.`;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return `Path parameter \`${name}\` must not be empty.`;
  if (trimmed === "." || trimmed === "..") {
    return `Path parameter \`${name}\` must not be a relative path segment ("." or "..").`;
  }
  if (value.includes("/") || value.includes("\\")) {
    return `Path parameter \`${name}\` must not contain a path separator.`;
  }
  if (ENCODED_SEPARATOR_RE.test(value)) {
    return `Path parameter \`${name}\` must not contain an encoded path separator or dot.`;
  }
  if (hasControlCharacter(value)) {
    return `Path parameter \`${name}\` must not contain control characters.`;
  }
  return null;
}

/** The JSON-Schema `type`(s) a derived property declares, if any. */
function declaredTypes(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const type = (schema as { type?: unknown }).type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type))
    return type.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      // An unknown/absent type constrains nothing — the v1 route still validates.
      return true;
  }
}

/** The JSON-Schema `enum` a derived property declares, if any. */
function declaredEnum(schema: unknown): readonly unknown[] | null {
  if (typeof schema !== "object" || schema === null) return null;
  const values = (schema as { enum?: unknown }).enum;
  return Array.isArray(values) ? values : null;
}

/** `value` against one schema's declared `type` and `enum`: the problem, or null. */
function schemaMismatch(value: unknown, schema: unknown): string | null {
  const types = declaredTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return `must be of type ${types.join(" | ")}`;
  }
  const allowed = declaredEnum(schema);
  if (allowed && !allowed.some((entry) => entry === value)) {
    return `must be one of: ${allowed.map(String).join(", ")}`;
  }
  return null;
}

/** What a query string can carry: dispatch sends each as `String(value)`. */
function isQueryScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Validates `tools/call` arguments against the tool's own `inputSchema`
 * BEFORE dispatch (review #54). Returns the first problem, or null.
 *
 * Pure and shallow by design: the v1 route remains the authority on business
 * validation, so this only enforces what the gateway itself publishes and
 * what it must not get wrong — no unknown keys (`additionalProperties:
 * false` was advertised but never enforced), required arguments present,
 * declared primitive types and `enum`s, the same for each item of an array
 * (F-34: `filter[status]: ["bogus"]` used to pass, and v1 then dropped the
 * filter), query values that are scalars or arrays of scalars (the only thing
 * a query string can carry), and the path-segment safety rules above.
 */
export function validateToolArguments(
  tool: Pick<GeneratedTool, "inputSchema" | "pathParams" | "queryParams">,
  args: Record<string, unknown>,
): string | null {
  const { properties, required = [] } = tool.inputSchema;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return `Unknown argument \`${key}\`.`;
  }
  for (const key of required) {
    if (args[key] === undefined) return `Missing required argument \`${key}\`.`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const schema = properties[key];
    const mismatch = schemaMismatch(value, schema);
    if (mismatch) return `Argument \`${key}\` ${mismatch}.`;
    const isQuery = tool.queryParams.includes(key);
    if (Array.isArray(value)) {
      const items =
        typeof schema === "object" && schema !== null
          ? (schema as { items?: unknown }).items
          : undefined;
      for (const item of value) {
        if (isQuery && !isQueryScalar(item)) {
          return `Each item of argument \`${key}\` must be a string, number or boolean.`;
        }
        const itemMismatch = schemaMismatch(item, items);
        if (itemMismatch) return `Each item of argument \`${key}\` ${itemMismatch}.`;
      }
    } else if (isQuery && !isQueryScalar(value)) {
      return `Argument \`${key}\` must be a string, number, boolean or an array of them.`;
    }
  }
  for (const name of tool.pathParams) {
    const rejection = pathParamRejection(name, args[name]);
    if (rejection) return rejection;
  }
  return null;
}

/** Builds the MCP tool for every scoped operation in the document. */
export function deriveMcpTools(document: Record<string, unknown>): GeneratedTool[] {
  const doc = document as OpenApiDoc;
  const docSecurity = doc.security ?? [];
  const tools: GeneratedTool[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op || !op.operationId || EXCLUDED_OPERATION_IDS.has(op.operationId)) continue;

      // A per-op `security: []` marks a public endpoint (token, jwks, openapi);
      // only scoped operations become tools.
      const effectiveSecurity = op.security ?? docSecurity;
      if (Array.isArray(effectiveSecurity) && effectiveSecurity.length === 0) continue;

      tools.push(buildTool(doc, method, path, op));
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The "requires …" clause of a tool's description, naming EVERY scope the
 * operation's `security` demands. Per OpenAPI, the requirement objects are
 * alternatives (any one suffices) and the scopes within one are all required,
 * so `[{ bearerAuth: [a, b] }, { bearerAuth: [a, c] }]` reads "a and b, or a
 * and c". Naming only the first scope of the first requirement (as this used
 * to) advertised `createUser` as needing `admin.users.create` alone, and an
 * agent granted just that got 403 on every call (F-480). `null` when the
 * operation names no bearer scope.
 */
function scopeClause(security: OpenApiOperation["security"]): string | null {
  const alternatives = (security ?? [])
    .map((requirement) => requirement.bearerAuth ?? [])
    .filter((scopes) => scopes.length > 0);
  if (alternatives.length === 0) return null;
  const all = (scopes: string[]) => scopes.map((scope) => `\`${scope}\``).join(" and ");
  const noun = alternatives.length === 1 && alternatives[0]!.length === 1 ? "scope" : "scopes";
  return `requires the ${alternatives.map(all).join(", or ")} ${noun}`;
}

function buildTool(
  doc: OpenApiDoc,
  method: string,
  path: string,
  op: OpenApiOperation,
): GeneratedTool {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const headerParams: string[] = [];
  const bodyProps: string[] = [];

  // Path params come straight from the `{…}` segments in the template.
  for (const match of path.matchAll(/\{(\w+)\}/g)) {
    const name = match[1]!;
    pathParams.push(name);
    properties[name] = { type: "string", description: `Path parameter \`${name}\`.` };
    required.add(name);
  }

  // Query params (path params are handled above; header params are not
  // mapped — see the description note below).
  for (const raw of op.parameters ?? []) {
    const param = raw.$ref ? doc.components?.parameters?.[refName(raw.$ref)] : raw;
    if (param?.name && param.in === "header") headerParams.push(param.name);
    if (!param?.name || param.in !== "query") continue;
    queryParams.push(param.name);
    properties[param.name] = {
      ...(param.schema ?? { type: "string" }),
      ...(param.description ? { description: param.description } : {}),
    };
    if (param.required) required.add(param.name);
  }

  // Request body — a single `$ref` to a flat component schema.
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema) {
    const schema =
      typeof bodySchema.$ref === "string"
        ? doc.components?.schemas?.[refName(bodySchema.$ref)]
        : (bodySchema as {
            properties?: Record<string, Record<string, unknown>>;
            required?: string[];
          });
    // Only FLAT object bodies are supported. A composed (allOf/oneOf/anyOf) or
    // otherwise unresolvable body yields no `properties`, which would silently
    // produce a tool an agent cannot call (its body params never appear in
    // inputSchema). Fail LOUDLY at derive time — this runs at module load and is
    // exercised by the mcp-openapi-tools test, so an unsupported body shape is
    // caught in CI, not at agent runtime. (audit #16)
    if (!schema || typeof schema.properties !== "object") {
      throw new Error(
        `MCP tool derivation: operation "${op.operationId}" declares a request body whose ` +
          `schema could not be flattened to properties (composed/nested bodies are unsupported). ` +
          `Flatten the schema or extend buildTool to resolve it.`,
      );
    }
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      bodyProps.push(name);
      properties[name] = propSchema;
    }
    for (const name of schema.required ?? []) required.add(name);
  }

  const scopes = scopeClause(op.security);
  const summary = op.summary ?? op.operationId!;
  // Header parameters are NOT tool arguments (F-34): `If-Match` on
  // `setUserStatus` needs the ETag `getUser` returns as a response HEADER,
  // which a tool result does not carry, so an agent could never supply a
  // current one. Say so rather than leave the summary ("supports `If-Match`")
  // promising a precondition the tool cannot send; the call runs without it.
  const headerNote =
    headerParams.length > 0
      ? ` The ${headerParams.map((name) => `\`${name}\``).join(", ")} header cannot be sent ` +
        `through this tool; the call is made without it.`
      : "";
  // The operation's own description (F-480: `createUser` states there what its
  // security cannot, e.g. the extra scope an `active` user needs).
  const detail = op.description ? ` ${op.description}` : "";
  const description = (scopes ? `${summary} (${scopes}).` : `${summary}.`) + detail + headerNote;

  const inputSchema: McpInputSchema = { type: "object", properties, additionalProperties: false };
  if (required.size > 0) inputSchema.required = [...required];

  return {
    name: op.operationId!,
    title: summary,
    description,
    inputSchema,
    method: method.toUpperCase(),
    path,
    pathParams,
    queryParams,
    bodyProps,
    readOnly: method === "get",
  };
}
