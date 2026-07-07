import "server-only";
import { NextRequest } from "next/server";
import { GET as meRouteGet } from "@/app/api/v1/me/route";
import { GET as usersRouteGet } from "@/app/api/v1/users/route";
import { type McpToolDefinition, type McpToolResult, textResult } from "./protocol";

/**
 * Phase 0 tool registry (design docs/design-mcp-agent-gateway.md §8). Each
 * tool is a thin proxy to the corresponding `/api/v1` route handler,
 * forwarding the caller's bearer credential — so authorization,
 * org-scoping, and projections are identical to the raw machine API, with
 * zero duplication. Read-only for now.
 */

type V1Handler = (request: NextRequest) => Promise<Response>;

export interface McpTool extends McpToolDefinition {
  run(request: NextRequest, args: Record<string, unknown>): Promise<McpToolResult>;
}

const INTERNAL_ORIGIN = "https://mcp.internal";

/** Forwards to a v1 GET handler and renders its JSON as an MCP tool result. */
async function proxyGet(
  request: NextRequest,
  handler: V1Handler,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<McpToolResult> {
  const url = new URL(path, INTERNAL_ORIGIN);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers = new Headers();
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);

  const response = await handler(new NextRequest(url, { headers }));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (body ?? {}) as { detail?: string; title?: string };
    return textResult(
      `Request failed (HTTP ${response.status}): ${problem.detail ?? problem.title ?? "error"}`,
      true,
    );
  }
  return textResult(JSON.stringify(body, null, 2));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Return the calling credential's identity, permissions, and effective scopes (GET /api/v1/me). Requires the account.read scope.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (request) => proxyGet(request, meRouteGet, "/api/v1/me"),
  },
  {
    name: "users_list",
    title: "List users",
    description:
      "List users the credential may see, scoped to its organization (GET /api/v1/users). Requires the admin.users.read scope.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search primary email or display name." },
        status: {
          type: "string",
          description:
            "Filter by status: active, pending_approval, blocked, suspended, or deactivated.",
        },
        page: { type: "integer", minimum: 1, description: "1-based page number (default 1)." },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Items per page (max 200, default 25).",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (request, args) =>
      proxyGet(request, usersRouteGet, "/api/v1/users", {
        q: optionalString(args.q),
        "filter[status]": optionalString(args.status),
        page: optionalNumber(args.page),
        pageSize: optionalNumber(args.page_size),
      }),
  },
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** Public tool definitions for `tools/list` (without the `run` closure). */
export function toolDefinitions(): McpToolDefinition[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}
