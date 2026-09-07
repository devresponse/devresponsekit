import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RequestIdModule from "@/lib/request-id";
import type * as AdminRequestIdModule from "@/lib/admin/request-id.server";

/**
 * Request-id provenance (review #99, #224).
 *
 * The correlation id ties the user-facing "Support ID", the `x-request-id`
 * response header, the Sentry tag, the stdout log line and
 * `app_audit_events.request_id` together. Honouring a client-supplied value
 * lets a caller collide or replay the ids operators search by (the audit
 * column is NOT unique) — a gap this app accepts in exchange for edge↔app
 * correlation — and `instrumentation.ts` tagged Sentry/stdout with the RAW
 * header, no format check at all, so control characters and markup reached
 * both sinks. That second half IS closed.
 *
 * These tests pin the four inputs that matter at every producer: a UUID with a
 * forwarded chain (honoured — INCLUDING when the chain is the client's own
 * invention, which is #224's remaining gap and is asserted explicitly below),
 * a UUID with no chain (rejected), malformed (rejected), and absent.
 */

const VALID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const sentry = vi.hoisted(() => ({
  tags: [] as Array<[string, unknown]>,
  captured: [] as unknown[],
}));

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: (...args: unknown[]) => sentry.captured.push(args),
  withScope: (cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) =>
    cb({ setTag: (k, v) => sentry.tags.push([k, v]) }),
}));
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));

let mod: typeof RequestIdModule;
let adminMod: typeof AdminRequestIdModule;

beforeEach(async () => {
  sentry.tags = [];
  sentry.captured = [];
  delete process.env.TRUSTED_PROXY_COUNT;
  mod = await import("@/lib/request-id");
  adminMod = await import("@/lib/admin/request-id.server");
});
afterEach(() => {
  delete process.env.TRUSTED_PROXY_COUNT;
  vi.resetModules();
});

describe("normalizeInboundRequestId", () => {
  it("honours a UUID that arrives with a forwarded chain", () => {
    expect(mod.normalizeInboundRequestId(VALID, "203.0.113.9")).toBe(VALID);
  });

  it("lower-cases an upper-case UUID so sinks agree on one spelling", () => {
    expect(mod.normalizeInboundRequestId(VALID.toUpperCase(), "203.0.113.9")).toBe(VALID);
  });

  it("REJECTS a well-formed id from a caller that sends NO forwarded chain", () => {
    // The only population the chain check excludes: an unmodified direct
    // request to a non-proxied origin, and local development.
    expect(mod.normalizeInboundRequestId(VALID, null)).toBeUndefined();
    expect(mod.normalizeInboundRequestId(VALID, "")).toBeUndefined();
    expect(mod.normalizeInboundRequestId(VALID, undefined)).toBeUndefined();
  });

  it("DOCUMENTED GAP (#224): a forged id is honoured once the client sends any XFF", () => {
    // `X-Forwarded-For` is client-supplied, so the chain check is not a
    // provenance check: adding one header defeats it, and behind a real edge
    // (Vercel, any LB) it is true for every request — making it a constant.
    // This test exists so the limitation is VISIBLE rather than implied to be
    // closed: the id below is chosen entirely by an untrusted caller and is
    // honoured, exactly as documented on `normalizeInboundRequestId`. If a
    // future change actually closes #224 (authenticate the header at the edge,
    // or always mint), this expectation must flip — deliberately, not silently.
    expect(mod.normalizeInboundRequestId(VALID, "1.2.3.4")).toBe(VALID);
  });

  it("requires as many hops as TRUSTED_PROXY_COUNT claims", async () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    vi.resetModules();
    const m = await import("@/lib/request-id");
    expect(m.normalizeInboundRequestId(VALID, "203.0.113.9")).toBeUndefined();
    expect(m.normalizeInboundRequestId(VALID, "203.0.113.9, 198.51.100.7")).toBe(VALID);
  });

  it("REJECTS malformed ids even with a forwarded chain present", () => {
    for (const bad of [
      "not-a-uuid",
      "<script>alert(1)</script>",
      `${VALID}\nfake log line: everything is fine`,
      `${VALID}\r\nx`,
      "x".repeat(4096),
      "",
      "   ",
      VALID.replace("-", ""),
      `${VALID}extra`,
    ]) {
      expect(mod.normalizeInboundRequestId(bad, "203.0.113.9"), bad.slice(0, 24)).toBeUndefined();
    }
  });

  it("REJECTS a non-string (absent, array-shaped, object)", () => {
    expect(mod.normalizeInboundRequestId(undefined, "203.0.113.9")).toBeUndefined();
    expect(mod.normalizeInboundRequestId(null, "203.0.113.9")).toBeUndefined();
    expect(mod.normalizeInboundRequestId([VALID], "203.0.113.9")).toBeUndefined();
    expect(mod.normalizeInboundRequestId({}, "203.0.113.9")).toBeUndefined();
  });

  it("tolerates surrounding whitespace on an otherwise valid id", () => {
    expect(mod.normalizeInboundRequestId(`  ${VALID}  `, "203.0.113.9")).toBe(VALID);
  });
});

describe("getOrCreateRequestId (review #224)", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("honours an inbound UUID that arrives with a forwarded chain", () => {
    const h = headers({ "x-request-id": VALID, "x-forwarded-for": "203.0.113.9" });
    expect(adminMod.getOrCreateRequestId(h)).toBe(VALID);
  });

  it("MINTS its own id for a caller that sends no forwarded chain", () => {
    const h = headers({ "x-request-id": VALID });
    const id = adminMod.getOrCreateRequestId(h);
    expect(id).not.toBe(VALID);
    expect(mod.isValidRequestId(id)).toBe(true);
  });

  it("DOCUMENTED GAP (#224): honours the id when that same caller adds an XFF", () => {
    // Same untrusted caller as the test above, one extra self-set header. The
    // Support ID that reaches the audit row, the response header and Sentry is
    // now the client's choice — it can be replayed or collided with another
    // request's. Pinned so the residual risk is asserted, not assumed away.
    const h = headers({ "x-request-id": VALID, "x-forwarded-for": "1.2.3.4" });
    expect(adminMod.getOrCreateRequestId(h)).toBe(VALID);
  });

  it("MINTS its own id for a malformed inbound value", () => {
    const h = headers({ "x-request-id": "<script>x</script>", "x-forwarded-for": "203.0.113.9" });
    const id = adminMod.getOrCreateRequestId(h);
    expect(mod.isValidRequestId(id)).toBe(true);
  });

  it("MINTS its own id when the header is absent", () => {
    expect(mod.isValidRequestId(adminMod.getOrCreateRequestId(headers({})))).toBe(true);
    expect(mod.isValidRequestId(adminMod.getOrCreateRequestId(undefined))).toBe(true);
  });

  it("memoises per request so one handler's sinks share one id", () => {
    const h = headers({});
    const carrier = { headers: h };
    const first = adminMod.getOrCreateRequestId(carrier);
    expect(adminMod.getOrCreateRequestId(carrier)).toBe(first);
    // Same underlying Headers reached through a different carrier shape.
    expect(adminMod.getOrCreateRequestId(h)).toBe(first);
  });

  it("still exports the header name other modules echo back", () => {
    expect(adminMod.REQUEST_ID_HEADER).toBe("x-request-id");
  });
});

describe("onRequestError request_id tag (review #99)", () => {
  async function fire(headers: Record<string, string | string[] | undefined>) {
    const { onRequestError } = await import("@/instrumentation");
    await onRequestError(
      new Error("boom"),
      { path: "/x", method: "GET", headers } as never,
      { routerKind: "App Router", routePath: "/x", routeType: "render" } as never,
    );
  }

  it("tags a well-formed inbound id that arrives with a forwarded chain", async () => {
    await fire({ "x-request-id": VALID, "x-forwarded-for": "203.0.113.9" });
    expect(sentry.tags).toContainEqual(["request_id", VALID]);
    expect(sentry.captured).toHaveLength(1);
  });

  it("tags NOTHING for an id from a caller that sends no forwarded chain", async () => {
    await fire({ "x-request-id": VALID });
    expect(sentry.tags).toHaveLength(0);
    // The error is still captured — the id is dropped, not the event.
    expect(sentry.captured).toHaveLength(1);
  });

  it("DOCUMENTED GAP (#224): tags a client-chosen id once an XFF is present", async () => {
    // The point of #99 was that this hook validated NOTHING; it now shares one
    // normaliser with the admin helper, so a malformed id can no longer poison
    // the tag. Forgery is a different question and is still open — asserted
    // here so the two halves are not confused for each other.
    await fire({ "x-request-id": VALID, "x-forwarded-for": "1.2.3.4" });
    expect(sentry.tags).toContainEqual(["request_id", VALID]);
  });

  it("tags NOTHING for a malformed id, so no control characters reach a sink", async () => {
    await fire({
      "x-request-id": "id\r\nInjected: header",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(sentry.tags).toHaveLength(0);
    expect(sentry.captured).toHaveLength(1);
  });

  it("tags nothing when the header is absent", async () => {
    await fire({});
    expect(sentry.tags).toHaveLength(0);
    expect(sentry.captured).toHaveLength(1);
  });

  it("reads the first value when the header arrives repeated (array shape)", async () => {
    await fire({ "x-request-id": [VALID, "second"], "x-forwarded-for": "203.0.113.9" });
    expect(sentry.tags).toContainEqual(["request_id", VALID]);
  });
});
