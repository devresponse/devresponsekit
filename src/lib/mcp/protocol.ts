/**
 * Model Context Protocol — pure protocol layer: JSON-RPC 2.0 envelopes,
 * version negotiation, and the MCP tool/result shapes. No `server-only`
 * imports, so it is trivially unit-testable. Transport and tool execution
 * live in the `.server.ts` siblings and the `/api/mcp` route.
 *
 * See docs/design-mcp-agent-gateway.md §8.
 */

/** Protocol revision this server implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Revisions we will echo back if a client requests one of them. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set<string>(["2025-06-18", "2025-03-26", "2024-11-05"]);

export const MCP_SERVER_INFO = { name: "devresponsekit", version: "1.0.0" } as const;

// ---- JSON-RPC 2.0 -----------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

// Standard JSON-RPC codes + one server-reserved code for auth.
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
/** Server-reserved range (-32000..-32099): unauthenticated caller. */
export const RPC_UNAUTHORIZED = -32001;

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorResponse["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** A parsed body is usable when it is an object carrying a string `method`. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage & { method: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as JsonRpcMessage).method === "string"
  );
}

/** A notification has a `method` but no `id` member (JSON-RPC 2.0). */
export function isNotification(message: JsonRpcMessage): boolean {
  return !("id" in message);
}

// ---- MCP shapes -------------------------------------------------------------

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: McpInputSchema;
  annotations?: McpToolAnnotations;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string, isError = false): McpToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

/** Echoes a supported requested version, else this server's version. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: typeof MCP_SERVER_INFO;
  instructions: string;
}

export function buildInitializeResult(requestedVersion: unknown): InitializeResult {
  return {
    protocolVersion: negotiateProtocolVersion(requestedVersion),
    capabilities: { tools: {} },
    serverInfo: MCP_SERVER_INFO,
    instructions:
      "DevResponseKit machine API over MCP. Call `whoami` to see the calling credential's effective scopes before invoking scoped tools.",
  };
}
