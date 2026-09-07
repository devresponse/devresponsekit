import "server-only";
import {
  type JsonRpcMessage,
  type JsonRpcResponse,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  buildInitializeResult,
  rpcError,
  rpcResult,
  textResult,
} from "./protocol";
import { findTool, toolDefinitions } from "./tools.server";

/**
 * Routes one JSON-RPC request to its MCP method handler. `forward` carries
 * the headers tools send to the v1 routes — the caller's bearer credential
 * (or the v1-audience token the route exchanged it for, review #50/#53) and
 * the trusted client-IP hop. Only the headers are needed, so the route can
 * hand over a rebuilt header set rather than the original NextRequest. Only
 * invoked for id-bearing requests (notifications get no response and are
 * handled by the route).
 */
export async function handleMcpRequest(
  message: JsonRpcMessage & { method: string },
  forward: { headers: Headers },
): Promise<JsonRpcResponse> {
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      return rpcResult(id, buildInitializeResult(params.protocolVersion));
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolDefinitions() });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const tool = findTool(name);
      if (!tool) {
        return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name || "(missing name)"}`);
      }
      if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
        return rpcError(id, RPC_INVALID_PARAMS, "`arguments` must be an object");
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // Arguments are checked against the tool's published inputSchema — and
      // path params against the segment-safety rules — BEFORE the tool can
      // touch the API (review #54). A refusal is a protocol error, not a tool
      // result: nothing was executed.
      const invalid = tool.validate(args);
      if (invalid) {
        return rpcError(id, RPC_INVALID_PARAMS, `Invalid arguments for ${name}: ${invalid}`);
      }
      try {
        return rpcResult(id, await tool.run(forward, args));
      } catch (error) {
        // Tool failures surface as an error *result*, not a protocol error,
        // so the agent sees which tool failed and why.
        return rpcResult(id, textResult(`Tool execution error: ${errorMessage(error)}`, true));
      }
    }
    default:
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `typeof null === "object"` and an array is an object too — neither is a params bag. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
