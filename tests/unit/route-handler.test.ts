import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { notFound } from "next/navigation";

/**
 * F-29: the request-id chokepoint (`src/lib/http/route-handler.server.ts`).
 *
 * The wrapper must (1) mint the id before the handler runs, so the handler's
 * own `getOrCreateRequestId(request)` calls (guard grant, audit rows, error
 * envelopes) read the same value; (2) stamp that id on every response the
 * handler returns; and (3) turn a throw into the surface's 500 envelope with
 * the same id in the header, the body and the log line. Before F-29 a success
 * built with `NextResponse.json` had no header, and a throw was Next's own
 * bodiless 500 whose `onRequestError` line logged `requestId: undefined`.
 */

vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/observability/server", () => ({ captureServerError: vi.fn() }));

import {
  withAdminRoute,
  withClientRegistrationRoute,
  withMcpRoute,
  withV1Route,
} from "@/lib/http/route-handler.server";
import { getOrCreateRequestId } from "@/lib/http/request-id.server";
import { InvalidListQueryError, parseListQuery } from "@/lib/admin/list-query.server";
import { logServerError } from "@/lib/observability/logger.server";
import { captureServerError } from "@/lib/observability/server";

const log = vi.mocked(logServerError);
const capture = vi.mocked(captureServerError);

const INBOUND = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://test.local/api/administrator/roles", { headers });
}

beforeEach(() => {
  log.mockReset();
  capture.mockReset();
});

describe("withAdminRoute: success responses", () => {
  it("stamps the id the handler itself saw onto a bare NextResponse.json", async () => {
    let seen = "";
    const GET = withAdminRoute(async function GET(req: NextRequest) {
      seen = getOrCreateRequestId(req);
      return NextResponse.json({ ok: true });
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(seen).toMatch(UUID);
    expect(res.headers.get("x-request-id")).toBe(seen);
  });

  it("the id is memoised on the request's Headers too (audit rows read either carrier)", async () => {
    let fromHeaders = "";
    const POST = withAdminRoute(async function POST(req: NextRequest) {
      fromHeaders = getOrCreateRequestId(req.headers);
      return new NextResponse(null, { status: 204 });
    });
    const res = await POST(request());
    expect(res.status).toBe(204);
    expect(res.headers.get("x-request-id")).toBe(fromHeaders);
  });

  it("honours a well-formed inbound id end to end (edge ↔ app correlation)", async () => {
    const GET = withAdminRoute(async function GET(_req: NextRequest) {
      return NextResponse.json({ ok: true });
    });
    const res = await GET(request({ "x-request-id": INBOUND, "x-forwarded-for": "203.0.113.9" }));
    expect(res.headers.get("x-request-id")).toBe(INBOUND);
  });

  it("keeps a header the handler already set", async () => {
    // A value the wrapper would never mint, so an unconditional overwrite fails
    // this test (the memoised id would make the two indistinguishable).
    const GET = withAdminRoute(async function GET(_req: NextRequest) {
      return NextResponse.json({}, { headers: { "x-request-id": "handler-set" } });
    });
    const req = request();
    const res = await GET(req);
    expect(res.headers.get("x-request-id")).toBe("handler-set");
    expect(getOrCreateRequestId(req)).not.toBe("handler-set");
  });

  it("stamps a response whose headers are immutable (Response.redirect) by copying it", async () => {
    const GET = withAdminRoute(async function GET(_req: NextRequest) {
      return Response.redirect("http://test.local/en/app", 307);
    });
    const req = request();
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://test.local/en/app");
    expect(res.headers.get("x-request-id")).toBe(getOrCreateRequestId(req));
  });

  it("passes the route context through untouched", async () => {
    const DELETE = withAdminRoute(async function DELETE(
      _req: NextRequest,
      ctx: { params: Promise<{ id: string }> },
    ) {
      const { id } = await ctx.params;
      return NextResponse.json({ id });
    });
    const res = await DELETE(request(), { params: Promise.resolve({ id: "r-1" }) });
    expect(await res.json()).toEqual({ id: "r-1" });
  });
});

describe("withAdminRoute: a throw becomes an id-stamped 500 envelope", () => {
  it("answers 500 internal_error with the SAME id in header, body and log line", async () => {
    const boom = new Error("duplicate key? no: connection terminated");
    let seen = "";
    const POST = withAdminRoute(async function POST(req: NextRequest) {
      seen = getOrCreateRequestId(req); // e.g. an audit row written before the throw
      throw boom;
    });
    const res = await POST(request());
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "internal_error",
      message: "errors.internal_error",
      requestId: seen,
    });
    expect(res.headers.get("x-request-id")).toBe(seen);
    // The log line and the Sentry tag carry the same id (OPS-OBS-2, D4).
    expect(log).toHaveBeenCalledWith(
      "admin.internal_error",
      expect.objectContaining({ requestId: seen, status: 500, err: boom }),
    );
    expect(capture).toHaveBeenCalledWith(boom, { requestId: seen, status: 500 });
  });

  it("carries an honoured inbound id into the 500 as well", async () => {
    const GET = withAdminRoute(async function GET(_req: NextRequest) {
      throw new Error("boom");
    });
    const res = await GET(request({ "x-request-id": INBOUND, "x-forwarded-for": "203.0.113.9" }));
    expect(res.headers.get("x-request-id")).toBe(INBOUND);
    expect(((await res.json()) as { requestId: string }).requestId).toBe(INBOUND);
    expect(log).toHaveBeenCalledWith(
      "admin.internal_error",
      expect.objectContaining({ requestId: INBOUND }),
    );
  });

  it("never puts the exception text on the wire", async () => {
    const GET = withAdminRoute(async function GET(_req: NextRequest) {
      throw new Error("password authentication failed for user devresponse");
    });
    const text = await (await GET(request())).text();
    expect(text).not.toMatch(/password|devresponse/);
  });

  it("re-throws Next's own control-flow errors instead of rendering them as a 500", async () => {
    const GET = withAdminRoute(async function GET(_req: NextRequest): Promise<Response> {
      notFound();
    });
    await expect(GET(request())).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/),
    });
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * F-63: `parseListQuery` refuses a page past MAX_PAGE or a malformed id filter
 * by throwing `InvalidListQueryError`. The wrapper answers it as the surface's
 * 400 with the parser's `detail`, where any other throw is a logged 500.
 */
describe("InvalidListQueryError becomes the surface's 400, not a 500", () => {
  const detail = "`filter[app_user_id]` must be a UUID.";

  it("withAdminRoute: 400 invalid_query with the detail, the id, and no log line", async () => {
    let seen = "";
    const GET = withAdminRoute(async function GET(req: NextRequest) {
      seen = getOrCreateRequestId(req);
      throw new InvalidListQueryError(detail);
    });
    const res = await GET(request());
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toBe(seen);
    expect(await res.json()).toEqual({
      detail,
      error: "invalid_query",
      message: "errors.invalid_query",
      requestId: seen,
    });
    expect(log).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("withV1Route: the 400 invalid_request problem every other v1 query refusal is", async () => {
    let seen = "";
    const GET = withV1Route(async function GET(req: NextRequest) {
      seen = getOrCreateRequestId(req);
      throw new InvalidListQueryError(detail);
    });
    const res = await GET(request());
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-request-id")).toBe(seen);
    expect(await res.json()).toMatchObject({
      status: 400,
      code: "invalid_request",
      detail,
      requestId: seen,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("a real handler: a page past MAX_PAGE is refused before the handler reads the database", async () => {
    const query = vi.fn();
    const GET = withAdminRoute(async function GET(req: NextRequest) {
      parseListQuery(req.nextUrl.searchParams, { allowedSortFields: [] });
      query();
      return NextResponse.json({});
    });
    const res = await GET(new NextRequest("http://test.local/api/x?page=99999999999999999999"));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("withV1Route", () => {
  it("stamps a success response", async () => {
    const GET = withV1Route(async function GET(_req: NextRequest) {
      return NextResponse.json({ ok: true });
    });
    const req = request();
    const res = await GET(req);
    expect(res.headers.get("x-request-id")).toBe(getOrCreateRequestId(req));
  });

  it("renders a throw as RFC 7807 problem+json with the same id in header, body and log", async () => {
    const boom = new Error("db down");
    let seen = "";
    const POST = withV1Route(async function POST(req: NextRequest) {
      seen = getOrCreateRequestId(req);
      throw boom;
    });
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-request-id")).toBe(seen);
    expect(await res.json()).toMatchObject({
      type: "https://devresponse.com/problems/internal_error",
      status: 500,
      code: "internal_error",
      requestId: seen,
    });
    expect(log).toHaveBeenCalledWith(
      "v1.internal_error",
      expect.objectContaining({ requestId: seen, status: 500, err: boom }),
    );
    expect(capture).toHaveBeenCalledWith(boom, { requestId: seen, status: 500 });
  });
});

/**
 * A-12: the MCP transport and RFC 7591 registration were exempt from F-29
 * because a throw in the admin or v1 envelope would put a non-protocol body on
 * the wire; so a throw was Next's bodiless 500 and no response carried an id.
 * Their wrappers keep the id handling and render the throw in the protocol's
 * own error shape.
 */
describe("withMcpRoute (JSON-RPC 2.0 transport)", () => {
  it("stamps every response, a plain-text 405 and a notification's 202 included", async () => {
    const GET = withMcpRoute(async function GET(_req: NextRequest) {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    });
    const POST = withMcpRoute(async function POST(_req: NextRequest) {
      return new Response(null, { status: 202 });
    });
    const get = request();
    const post = request();
    expect((await GET(get)).headers.get("x-request-id")).toBe(getOrCreateRequestId(get));
    expect((await POST(post)).headers.get("x-request-id")).toBe(getOrCreateRequestId(post));
  });

  it("answers a throw with a JSON-RPC -32603 error under the same id in header, body and log", async () => {
    const boom = new Error("could not mint the exchange token");
    let seen = "";
    const POST = withMcpRoute(async function POST(req: NextRequest): Promise<Response> {
      seen = getOrCreateRequestId(req);
      throw boom;
    });
    const res = await POST(request({ "x-request-id": INBOUND, "x-forwarded-for": "203.0.113.9" }));
    expect(seen).toBe(INBOUND);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe(seen);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error", data: { requestId: seen } },
    });
    expect(log).toHaveBeenCalledWith(
      "mcp.internal_error",
      expect.objectContaining({ requestId: seen, status: 500, err: boom }),
    );
    expect(capture).toHaveBeenCalledWith(boom, { requestId: seen, status: 500 });
  });

  it("never puts the exception text on the wire", async () => {
    const POST = withMcpRoute(async function POST(_req: NextRequest): Promise<Response> {
      throw new Error("password authentication failed for user devresponse");
    });
    expect(await (await POST(request())).text()).not.toMatch(/password|devresponse/);
  });
});

describe("withClientRegistrationRoute (RFC 7591)", () => {
  it("stamps a success response", async () => {
    const POST = withClientRegistrationRoute(async function POST(_req: NextRequest) {
      return new Response(JSON.stringify({ client_id: "c" }), { status: 201 });
    });
    const req = request();
    expect((await POST(req)).headers.get("x-request-id")).toBe(getOrCreateRequestId(req));
  });

  it("answers a throw with the RFC 7591 error shape (server_error), the id in the header and log", async () => {
    const boom = new Error("advisory lock timeout");
    let seen = "";
    const POST = withClientRegistrationRoute(async function POST(
      req: NextRequest,
    ): Promise<Response> {
      seen = getOrCreateRequestId(req);
      throw boom;
    });
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe(seen);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "server_error",
      error_description: "The registration could not be completed.",
    });
    expect(log).toHaveBeenCalledWith(
      "mcp.register.internal_error",
      expect.objectContaining({ requestId: seen, status: 500, err: boom }),
    );
    expect(capture).toHaveBeenCalledWith(boom, { requestId: seen, status: 500 });
  });
});
