import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { notFound } from "next/navigation";

/**
 * F-29: the request-id chokepoint (`src/lib/route-handler.server.ts`).
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

import { withAdminRoute, withV1Route } from "@/lib/route-handler.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
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
