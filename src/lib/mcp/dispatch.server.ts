import "server-only";
import type { NextRequest } from "next/server";
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
 * Routes one JSON-RPC request to its MCP method handler. The original
 * request is threaded through so tools can forward the caller's bearer
 * credential to the v1 routes. Only invoked for id-bearing requests
 * (notifications get no response and are handled by the route).
 */
export async function handleMcpRequest(
  message: JsonRpcMessage & { method: string },
  request: NextRequest,
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
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return rpcResult(id, await tool.run(request, args));
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
