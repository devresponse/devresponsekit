import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Error-envelope parity per SURFACE (review #45).
 *
 * The self-service routes share ONE authorization decision but live on two
 * surfaces with two published error contracts:
 *
 *   - `/api/account/*` + `/api/preferences/*` — the first-party envelope
 *     `{ error, message: "errors.<code>", requestId }` (`application/json`),
 *   - `/api/v1/me*` — RFC 7807 `application/problem+json`, which the OpenAPI
 *     document `$ref`s for every 4xx and the generated SDK parses.
 *
 * Reusing `requireAccountUser` on v1 meant every v1 rejection answered in the
 * ADMIN envelope: a client parsing a problem document got `undefined` for
 * `type`, `status` and `code`, and the served spec was simply wrong. This
 * suite drives the REAL guards (only the caller resolver and the repos are
 * mocked) and pins the envelope for every rejection reason on both surfaces —
 * so a route wired to the wrong guard fails here.
 */
const resolveCaller = vi.fn();
const hasBearerCredential = vi.fn();

vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...a: unknown[]) => resolveCaller(...a),
  hasBearerCredential: (...a: unknown[]) => hasBearerCredential(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { updateUser: vi.fn() }, $context: Promise.resolve({ internalAdapter: {} }) },
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  listApiKeysForUser: vi.fn(async () => []),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(async () => undefined),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));
vi.mock("@/db/database", () => ({
  db: {
    updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => undefined }) }) }),
    insertInto: () => ({
      values: () => ({ onConflict: () => ({ execute: async () => undefined }) }),
    }),
  },
}));

const ACCESS = {
  appUserId: "app-self",
  primaryEmail: "self@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

/** `grantedScopes: null` models a cookie session; an array models a bearer. */
function caller(grantedScopes: string[] | null, overrides: Record<string, unknown> = {}) {
  const bearer = grantedScopes !== null;
  return {
    kind: bearer ? "api_key" : "session",
    betterAuthUserId: "ba-self",
    access: { ...ACCESS, ...(overrides.access as object) },
    grantedScopes,
    isBearer: bearer,
    credentialId: bearer ? "key-1" : null,
    impersonatorId: null,
  };
}

function makeReq(path: string, method: string, bearer: boolean): NextRequest {
  const url = new URL(`http://test.local${path}`);
  const headers = new Headers({ origin: "http://test.local" });
  if (bearer) headers.set("authorization", "Bearer drk_test_x.secret");
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers,
    json: async () => ({ name: "Ada" }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  resolveCaller.mockReset();
  hasBearerCredential.mockReset();
  hasBearerCredential.mockImplementation((h: Headers) => h.has("authorization"));
});
afterEach(() => vi.resetModules());

/** Every rejection reason the shared account decision can produce. */
const REJECTIONS = [
  {
    name: "unauthenticated",
    status: 401,
    adminCode: "unauthenticated",
    setup: () => resolveCaller.mockResolvedValue(null),
  },
  {
    name: "blocked member",
    status: 403,
    adminCode: "forbidden",
    setup: () =>
      resolveCaller.mockResolvedValue(
        caller(["account.read", "account.apikeys.manage"], {
          access: { ...ACCESS, status: "blocked" },
        }),
      ),
  },
  {
    name: "unprovisioned",
    status: 403,
    adminCode: "not_provisioned",
    setup: () =>
      resolveCaller.mockResolvedValue(
        caller(["account.read", "account.apikeys.manage"], {
          access: { ...ACCESS, appUserId: null },
        }),
      ),
  },
  {
    name: "insufficient scope",
    status: 403,
    adminCode: "insufficient_scope",
    setup: () => resolveCaller.mockResolvedValue(caller([])),
  },
] as const;

describe("v1 self-service routes answer application/problem+json (#45)", () => {
  it.each(REJECTIONS.map((r) => [r.name, r] as const))(
    "GET /api/v1/me — %s",
    async (_name, rejection) => {
      rejection.setup();
      const { GET } = await import("@/app/api/v1/me/route");
      const res = await GET(makeReq("/api/v1/me", "GET", true));
      expect(res.status).toBe(rejection.status);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const body = (await res.json()) as Record<string, unknown>;
      // The RFC 7807 members the OpenAPI `Problem` schema promises.
      expect(body.status).toBe(rejection.status);
      expect(String(body.type)).toContain("/problems/");
      expect(typeof body.title).toBe("string");
      expect(typeof body.requestId).toBe("string");
      // …and NOT the admin envelope.
      expect(body.message).toBeUndefined();
      expect(body.error).toBeUndefined();
    },
  );

  it("401 carries the RFC 6750 bearer challenge, like the v1 permission guard", async () => {
    resolveCaller.mockResolvedValue(null);
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(makeReq("/api/v1/me", "GET", true));
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="devresponse-api"');
  });

  it.each([
    ["GET /api/v1/me/api-keys", "@/app/api/v1/me/api-keys/route", "GET"],
    ["POST /api/v1/me/api-keys", "@/app/api/v1/me/api-keys/route", "POST"],
  ] as const)("%s rejects in problem+json", async (_name, mod, method) => {
    resolveCaller.mockResolvedValue(caller([]));
    const route = (await import(mod)) as Record<string, (r: NextRequest) => Promise<Response>>;
    const res = await route[method]!(makeReq("/api/v1/me/api-keys", method, true));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it.each([
    ["DELETE /api/v1/me/api-keys/[id]", "@/app/api/v1/me/api-keys/[id]/route", "DELETE"],
    ["POST /api/v1/me/api-keys/[id]/rotate", "@/app/api/v1/me/api-keys/[id]/rotate/route", "POST"],
  ] as const)("%s rejects in problem+json", async (_name, mod, method) => {
    resolveCaller.mockResolvedValue(caller([]));
    const route = (await import(mod)) as Record<
      string,
      (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>
    >;
    const res = await route[method]!(makeReq("/api/v1/me/api-keys/x", method, true), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("first-party account routes keep the { error, message } envelope (#45)", () => {
  it("PATCH /api/account/profile — insufficient scope stays the admin envelope", async () => {
    resolveCaller.mockResolvedValue(caller(["account.read"]));
    const { PATCH } = await import("@/app/api/account/profile/route");
    const res = await PATCH(makeReq("/api/account/profile", "PATCH", true));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("problem");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "insufficient_scope",
      message: "errors.insufficient_scope",
    });
    expect(body.type).toBeUndefined();
  });

  it("PUT /api/account/preferences — unauthenticated stays the admin envelope", async () => {
    resolveCaller.mockResolvedValue(null);
    const { PUT } = await import("@/app/api/account/preferences/route");
    const res = await PUT(makeReq("/api/account/preferences", "PUT", true));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toContain("problem");
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unauthenticated" });
  });
});
