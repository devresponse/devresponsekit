import "server-only";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { getClientIp } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import { deriveMcpTools, validateToolArguments, type GeneratedTool } from "./openapi-tools";
import {
  type McpToolDefinition,
  type McpToolResult,
  textResult,
  untrustedDataResult,
} from "./protocol";

/**
 * The MCP tool surface (Phase 3, design docs/design-mcp-agent-gateway.md
 * §11). Tools are DERIVED from the OpenAPI document at load time — one per
 * scoped `/api/v1` operation — and each dispatches by calling the v1 API
 * with the caller's own bearer credential forwarded, so authorization,
 * org-scoping, and projections stay identical to the raw API. The gateway
 * is a client of the API it fronts.
 */

const GENERATED: GeneratedTool[] = deriveMcpTools(buildOpenApiDocument("https://mcp.internal"));

export interface McpTool extends McpToolDefinition {
  /**
   * Argument validation against this tool's own `inputSchema` (review #54).
   * Returns a message when the call must be refused with
   * `-32602 Invalid params`, else null. Separate from {@link McpTool.run} so
   * the dispatcher can answer with a PROTOCOL error rather than a tool
   * result — an unroutable call never reaches the API.
   */
  validate(args: Record<string, unknown>): string | null;
  run(request: { headers: Headers }, args: Record<string, unknown>): Promise<McpToolResult>;
}

const TOOLS: McpTool[] = GENERATED.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
  validate: (args) => validateToolArguments(tool, args),
  run: (request, args) => dispatch(tool, request, args),
}));

/**
 * The origin the gateway self-calls. `MCP_DISPATCH_BASE_URL` lets an operator
 * point the hop at an origin that reaches the app WITHOUT traversing the edge
 * proxy (review #55) — which is what makes the forwarded client IP below
 * meaningful; unset, it is the public `BETTER_AUTH_URL`, i.e. today's
 * behaviour.
 */
function dispatchBaseUrl(): string {
  const env = getServerEnv();
  return (env.MCP_DISPATCH_BASE_URL ?? env.BETTER_AUTH_URL).replace(/\/+$/, "");
}

async function dispatch(
  tool: GeneratedTool,
  request: { headers: Headers },
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  // Defence in depth: `dispatch` is only reached through `McpTool.validate`
  // (see dispatch.server.ts), but a future caller must not be able to skip
  // the path-segment rules and re-route the self-fetch (review #54).
  const invalid = validateToolArguments(tool, args);
  if (invalid) return textResult(`Invalid arguments: ${invalid}`, true);

  const base = dispatchBaseUrl();
  const relativePath = tool.path.replace(/\{(\w+)\}/g, (_full, name: string) =>
    encodeURIComponent(String(args[name] ?? "")),
  );
  const url = new URL(`${base}/api/v1${relativePath}`);
  // `new URL` RESOLVES dot segments, so compare what it produced against what
  // we asked for: any normalisation means the request would land on a route
  // the tool did not name (review #54). Validation already refuses the known
  // inputs that do this; this is the invariant, checked.
  const expectedPath = new URL(`${base}/api/v1`).pathname.replace(/\/+$/, "") + relativePath;
  if (url.pathname !== expectedPath) {
    return textResult(
      `Invalid arguments: the resolved request path does not match the tool's endpoint.`,
      true,
    );
  }
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const headers: Record<string, string> = {};
  const auth = request.headers.get("authorization");
  if (auth) headers.authorization = auth;

  // Forward the AGENT's resolved client IP so the v1 route audits and
  // rate-limits against it, not the gateway's own address (audit #14). We
  // resolve it here (honoring TRUSTED_PROXY_COUNT at the MCP boundary) and
  // pass it as `x-forwarded-for` — the same trusted channel v1's getClientIp
  // reads — rather than a bespoke header an external v1 caller could spoof.
  //
  // This only works where the self-fetch reaches the app DIRECTLY. Behind a
  // proxy that appends its own hop (Vercel's edge, for one), v1's getClientIp
  // selects the gateway's address and the forwarded value is silently
  // discarded — so the honest deployment options are: point
  // `MCP_DISPATCH_BASE_URL` at an origin that bypasses the proxy, or set
  // `MCP_FORWARD_CLIENT_IP=0` and let v1 audit the gateway hop instead of
  // pretending an agent IP survives it (review #231, #55).
  if (getServerEnv().MCP_FORWARD_CLIENT_IP) {
    const clientIp = getClientIp(request.headers);
    if (clientIp) headers["x-forwarded-for"] = clientIp;
  }

  let body: string | undefined;
  if (tool.bodyProps.length > 0) {
    const payload: Record<string, unknown> = {};
    for (const name of tool.bodyProps) if (args[name] !== undefined) payload[name] = args[name];
    if (Object.keys(payload).length > 0) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(payload);
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: tool.method, headers, body });
  } catch (error) {
    return textResult(
      `Could not reach the API: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  // Both branches LABEL the API payload as untrusted data (review #208):
  // a problem+json `detail` echoes user-controlled input just as a success
  // body does, so neither may enter the agent's context unmarked.
  const text = await response.text();
  const summary = `${tool.method} /api/v1${tool.path} → HTTP ${response.status}`;
  if (!response.ok) {
    const problem = safeParse(text);
    return untrustedDataResult(problem?.detail ?? problem?.title ?? text.slice(0, 300), {
      summary: `Request failed. ${summary}`,
      isError: true,
    });
  }
  return untrustedDataResult(text.length > 0 ? text : "{}", { summary });
}

function safeParse(text: string): { detail?: string; title?: string } | null {
  try {
    return JSON.parse(text) as { detail?: string; title?: string };
  } catch {
    return null;
  }
}

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** Public tool definitions for `tools/list` (without the `run` closure). */
export function toolDefinitions(): McpToolDefinition[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}
