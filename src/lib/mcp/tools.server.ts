import "server-only";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { getClientIp } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import { deriveMcpTools, type GeneratedTool } from "./openapi-tools";
import { type McpToolDefinition, type McpToolResult, textResult } from "./protocol";

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
  run(request: { headers: Headers }, args: Record<string, unknown>): Promise<McpToolResult>;
}

const TOOLS: McpTool[] = GENERATED.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
  run: (request, args) => dispatch(tool, request, args),
}));

async function dispatch(
  tool: GeneratedTool,
  request: { headers: Headers },
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const base = getServerEnv().BETTER_AUTH_URL.replace(/\/+$/, "");
  const path = tool.path.replace(/\{(\w+)\}/g, (_full, name: string) =>
    encodeURIComponent(String(args[name] ?? "")),
  );
  const url = new URL(`${base}/api/v1${path}`);
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const headers: Record<string, string> = {};
  const auth = request.headers.get("authorization");
  if (auth) headers.authorization = auth;

  // Forward the AGENT's resolved client IP so the v1 route audits and
  // rate-limits against it, not the gateway's own address (audit #14). We
  // resolve it here (honoring TRUSTED_PROXY_COUNT at the MCP boundary) and pass
  // it as `x-forwarded-for` — the same trusted channel v1's getClientIp reads —
  // rather than a bespoke header an external v1 caller could spoof.
  const clientIp = getClientIp(request.headers);
  if (clientIp) headers["x-forwarded-for"] = clientIp;

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

  const text = await response.text();
  if (!response.ok) {
    const problem = safeParse(text);
    return textResult(
      `Request failed (HTTP ${response.status}): ${problem?.detail ?? problem?.title ?? text.slice(0, 300)}`,
      true,
    );
  }
  return textResult(text.length > 0 ? text : "{}");
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
