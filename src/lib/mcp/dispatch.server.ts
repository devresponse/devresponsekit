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

/** What the route knows about the resolved caller, as the methods below need it. */
export interface McpCallerContext {
  /**
   * Whether the calling credential can exercise `scope`, by the rule the v1
   * guards apply (`effectiveScopeHolder`). `tools/list` offers only the tools
   * this admits (I-04).
   */
  holdsScope: (scope: string) => boolean;
  /**
   * Builds the headers tools send to the v1 routes: the caller's bearer
   * credential (or the v1-audience token the route exchanges it for, review
   * #50/#53) and the trusted client-IP hop. Only the headers are needed, so
   * the route hands over a rebuilt header set rather than the NextRequest.
   * A function, called only by `tools/call`, so `initialize`, `ping` and
   * `tools/list` mint no exchange token they would never use (I-04).
   */
  forwardHeaders: () => Promise<Headers>;
}

/**
 * Routes one JSON-RPC request to its MCP method handler. Only invoked for
 * id-bearing requests (notifications get no response and are handled by the
 * route).
 */
export async function handleMcpRequest(
  message: JsonRpcMessage & { method: string },
  caller: McpCallerContext,
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
      return rpcResult(id, { tools: toolDefinitions(caller.holdsScope) });
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
      // Outside the try: a failure to mint the exchange token is the server's
      // own fault and must end in a logged 500, not read as a tool error.
      const forward = { headers: await caller.forwardHeaders() };
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
