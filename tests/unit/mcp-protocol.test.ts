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

/**
 * The `initialize` instructions name a tool for the client to call first.
 * Tools are named by OpenAPI operationId and `findTool` is an exact match,
 * so a stale name (the pre-Phase-3 `whoami`) silently sends every agent to
 * `Unknown tool` (review #127). Pin every backticked name against the real
 * derived tool set.
 */
describe("MCP initialize instructions", () => {
  it("only name tools that exist in the generated tool surface", async () => {
    const { buildOpenApiDocument } = await import("@/lib/api-auth/openapi");
    const { deriveMcpTools } = await import("@/lib/mcp/openapi-tools");
    const toolNames = new Set(
      deriveMcpTools(buildOpenApiDocument("https://x.example")).map((t) => t.name),
    );
    const named = [...buildInitializeResult("2025-06-18").instructions.matchAll(/`([^`]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(toolNames.has(name), `tool ${name} exists`).toBe(true);
  });
});
