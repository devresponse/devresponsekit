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
  const bodyProps: string[] = [];

  // Path params come straight from the `{…}` segments in the template.
  for (const match of path.matchAll(/\{(\w+)\}/g)) {
    const name = match[1]!;
    pathParams.push(name);
    properties[name] = { type: "string", description: `Path parameter \`${name}\`.` };
    required.add(name);
  }

  // Query params (path/header params are handled above / ignored).
  for (const raw of op.parameters ?? []) {
    const param = raw.$ref ? doc.components?.parameters?.[refName(raw.$ref)] : raw;
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
    for (const [name, propSchema] of Object.entries(schema?.properties ?? {})) {
      bodyProps.push(name);
      properties[name] = propSchema;
    }
    for (const name of schema?.required ?? []) required.add(name);
  }

  const scope = op.security?.[0]?.bearerAuth?.[0];
  const summary = op.summary ?? op.operationId!;
  const description = scope ? `${summary} (requires the \`${scope}\` scope).` : `${summary}.`;

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
