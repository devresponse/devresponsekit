import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  buildInitializeResult,
  isJsonRpcMessage,
  isNotification,
  negotiateProtocolVersion,
  rpcError,
  rpcResult,
  textResult,
} from "@/lib/mcp/protocol";

/**
 * Unit coverage for the pure MCP protocol layer — no transport, auth, or
 * DB. The route + tool wiring is exercised at the integration layer
 * (tests/integration/mcp-route.test.ts).
 */
describe("MCP protocol", () => {
  it("negotiates a supported protocol version, else falls back to ours", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
  });

  it("builds an initialize result advertising the tools capability", () => {
    const result = buildInitializeResult("2025-06-18");
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo.name).toBe("devresponsekit");
  });

  it("shapes JSON-RPC success and error envelopes", () => {
    expect(rpcResult(1, { ok: true })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(rpcError(2, -32601, "nope")).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "nope" },
    });
  });

  it("marks tool error results and omits isError on success", () => {
    expect(textResult("bad", true)).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
    expect(textResult("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("recognizes JSON-RPC messages and notifications", () => {
    expect(isJsonRpcMessage({ method: "ping" })).toBe(true);
    expect(isJsonRpcMessage({ id: 1 })).toBe(false);
    expect(isNotification({ method: "notifications/initialized" })).toBe(true);
    expect(isNotification({ method: "initialize", id: 1 })).toBe(false);
  });
});
