import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as GuardModule from "@/lib/account/guard.server";
import type * as EnvModule from "@/lib/env";

/**
 * F-29, end to end through real route modules: the `x-request-id` a caller
 * receives is the id in the audit rows the request wrote and in the log line
 * of the error it raised — on a SUCCESS and on an uncaught THROW.
 *
 * Before F-29, `POST /api/administrator/roles` answered its 201 with a bare
 * `NextResponse.json` (no header, so the `admin.role.created` row could not be
 * joined to the request), and a non-unique insert failure hit the route's
 * `throw err` and became Next's bodiless 500: no header, no envelope, and an
 * `onRequestError` log line with `requestId: undefined`. The v1 twin (`POST
 * /api/v1/me/api-keys` with the repository failing) rejected the same way.
 *
 * The real `auditEvent` runs, so the asserted id is the one actually written
 * to `app_audit_events.request_id`; only the database, the session and the
 * log/Sentry sinks are stubbed.
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const selectFirst = vi.fn();
const insertRole = vi.fn();
const auditRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/db/database", () => {
  // Any read chain ends in `selectFirst` (the global-role duplicate check).
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "executeTakeFirst") return selectFirst;
        if (prop === "execute") return async () => [];
        return () => chain;
      },
    },
  );
  return {
    db: {
      selectFrom: () => chain,
      insertInto: (table: string) => ({
        values: (row: Record<string, unknown>) => {
          if (table === "app_audit_events") {
            return {
              execute: async () => {
                auditRows.push(row);
                return [];
              },
            };
          }
          return { returning: () => ({ executeTakeFirstOrThrow: () => insertRole(row) }) };
        },
      }),
    },
  };
});
const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logServerError(...a),
}));
vi.mock("@/lib/observability/server", () => ({ captureServerError: vi.fn() }));

// v1 route: the self-service guard + key repository are stubbed (as in
// api-v1-me-api-keys.test.ts); the confinement helpers run for real.
const requireApiAccount = vi.fn();
const createApiKey = vi.fn();
vi.mock("@/lib/account/guard.server", async (importOriginal) => ({
  ...(await importOriginal<typeof GuardModule>()),
  requireApiAccount: (...a: unknown[]) => requireApiAccount(...a),
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  listApiKeysForUser: vi.fn(),
  createApiKey: (...a: unknown[]) => createApiKey(...a),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getServerEnv: () => ({ API_KEY_DEFAULT_TTL_DAYS: null }),
}));

const INBOUND = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function jsonReq(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  const url = `http://test.local${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: async () => body,
  } as unknown as NextRequest;
}

const SUPERADMIN = {
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.roles.create", "superuser"],
};

beforeEach(() => {
  for (const m of [
    sessionGetter,
    accessGetter,
    selectFirst,
    insertRole,
    requireApiAccount,
    createApiKey,
    logServerError,
  ])
    m.mockReset();
  auditRows.length = 0;
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  accessGetter.mockResolvedValue(SUPERADMIN);
  selectFirst.mockResolvedValue(undefined); // no duplicate global key
});
afterEach(() => vi.resetModules());

describe("F-29 admin surface: POST /api/administrator/roles", () => {
  it("a 201 carries x-request-id, and it is the id on the audit row it wrote", async () => {
    insertRole.mockResolvedValue({ id: "r-new", key: "x.y" });
    const { POST } = await import("@/app/api/administrator/roles/route");
    const res = await POST(jsonReq("/api/administrator/roles", { key: "x.y", name: "X" }));

    expect(res.status).toBe(201);
    const header = res.headers.get("x-request-id");
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    const created = auditRows.find((r) => r.event_type === "admin.role.created");
    expect(created?.request_id).toBe(header);
  });

  it("an honoured inbound id is the one on the header AND the audit row", async () => {
    insertRole.mockResolvedValue({ id: "r-new", key: "x.y" });
    const { POST } = await import("@/app/api/administrator/roles/route");
    const res = await POST(
      jsonReq(
        "/api/administrator/roles",
        { key: "x.y", name: "X" },
        { "x-request-id": INBOUND, "x-forwarded-for": "203.0.113.9" },
      ),
    );
    expect(res.headers.get("x-request-id")).toBe(INBOUND);
    expect(auditRows.map((r) => r.request_id)).toEqual([INBOUND]);
  });

  it("a thrown insert failure (`throw err`) is an id-stamped 500 envelope, logged under that id", async () => {
    const dbError = new Error("connection terminated unexpectedly");
    insertRole.mockRejectedValue(dbError);
    const { POST } = await import("@/app/api/administrator/roles/route");
    const res = await POST(jsonReq("/api/administrator/roles", { key: "x.y", name: "X" }));

    expect(res.status).toBe(500);
    const header = res.headers.get("x-request-id");
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({
      error: "internal_error",
      message: "errors.internal_error",
      requestId: header,
    });
    expect(logServerError).toHaveBeenCalledWith(
      "admin.internal_error",
      expect.objectContaining({ requestId: header, status: 500, err: dbError }),
    );
  });
});

describe("F-29 v1 surface: POST /api/v1/me/api-keys", () => {
  it("a thrown repository failure is an id-stamped problem+json 500, logged under that id", async () => {
    requireApiAccount.mockResolvedValue({
      ok: true,
      actor: {
        appUserId: "u1",
        betterAuthUserId: "ba1",
        callerKind: "session",
        impersonatorId: null,
        grantedScopes: null,
        access: { permissions: ["account.apikeys.manage"], organizationId: "o1" },
      },
    });
    const dbError = new Error("db down");
    createApiKey.mockRejectedValue(dbError);
    const { POST } = await import("@/app/api/v1/me/api-keys/route");
    const res = await POST(
      jsonReq(
        "/api/v1/me/api-keys",
        { name: "ci", scopes: ["account.read"] },
        { "x-request-id": INBOUND, "x-forwarded-for": "203.0.113.9" },
      ),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-request-id")).toBe(INBOUND);
    expect(await res.json()).toMatchObject({ code: "internal_error", requestId: INBOUND });
    expect(logServerError).toHaveBeenCalledWith(
      "v1.internal_error",
      expect.objectContaining({ requestId: INBOUND, status: 500, err: dbError }),
    );
  });
});
