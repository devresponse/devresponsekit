import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Query-parameter validation on the two v1 credential LISTINGS (review #47).
 *
 * `GET /api/v1/admin/api-keys` and `GET /api/v1/admin/oauth-clients` parsed
 * `page` / `pageSize` by hand (`Number(x) || 1`) and passed `appUserId`
 * straight through. `Number("1.5")` is a fraction and `Number("1e400")` is
 * `Infinity`, so the computed OFFSET was not an integer; a non-UUID
 * `appUserId` reached a `uuid` comparison. Postgres answers 22P02 either way,
 * which the route surfaced as a 500 — an invalid REQUEST reported as a server
 * fault, and a free error oracle. The listings now share the repo's
 * list-query parser and validate the id against the `uuid` format the OpenAPI
 * document already declares.
 *
 * The repos are mocked and RECORD what the route asked for, so the assertions
 * are about the values that would have reached SQL.
 */
const requireApiPermission = vi.fn();
const listApiKeysAdmin = vi.fn();
const listOauthClients = vi.fn();

vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: () => null,
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  listApiKeysAdmin: (...a: unknown[]) => listApiKeysAdmin(...a),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  listOauthClients: (...a: unknown[]) => listOauthClients(...a),
  createOauthClient: vi.fn(),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/db/database", () => ({ db: { selectFrom: () => ({}) } }));

/** A SUPERADMIN grant: `resolveOrgScope` runs for real and yields `all`. */
const SUPERADMIN_GRANT = {
  ok: true,
  grant: {
    requestId: "req-1",
    caller: {
      betterAuthUserId: "ba1",
      credentialId: "k1",
      kind: "api_key",
      access: {
        appUserId: "u1",
        status: "active",
        membershipStatus: "active",
        organizationId: "o1",
        permissions: ["admin.apikeys.read", "admin.clients.read", "superuser"],
      },
    },
  },
};

function req(path: string, query: string): NextRequest {
  const url = new URL(`http://test.local${path}?${query}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  for (const m of [requireApiPermission, listApiKeysAdmin, listOauthClients]) m.mockReset();
  requireApiPermission.mockResolvedValue(SUPERADMIN_GRANT);
  listApiKeysAdmin.mockResolvedValue({ items: [], total: 0 });
  listOauthClients.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/admin/api-keys — query validation (#47)", () => {
  it("400 problem+json for a non-UUID appUserId, and never touches the repo", async () => {
    const { GET } = await import("@/app/api/v1/admin/api-keys/route");
    const res = await GET(req("/api/v1/admin/api-keys", "appUserId=not-a-uuid"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    expect(listApiKeysAdmin).not.toHaveBeenCalled();
  });

  it("accepts a well-formed appUserId and forwards it", async () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const { GET } = await import("@/app/api/v1/admin/api-keys/route");
    const res = await GET(req("/api/v1/admin/api-keys", `appUserId=${id}`));
    expect(res.status).toBe(200);
    expect(listApiKeysAdmin).toHaveBeenCalledWith(expect.objectContaining({ appUserId: id }));
  });

  it.each([
    ["1.5", 1, 25, 0],
    ["1e400", 1, 25, 0],
    ["-3", 1, 25, 0],
    ["abc", 1, 25, 0],
    ["3", 3, 25, 50],
  ])("page=%s yields integer page/offset", async (page, expPage, expSize, expOffset) => {
    const { GET } = await import("@/app/api/v1/admin/api-keys/route");
    const res = await GET(req("/api/v1/admin/api-keys", `page=${page}`));
    expect(res.status).toBe(200);
    const arg = listApiKeysAdmin.mock.calls[0]?.[0] as { limit: number; offset: number };
    expect(Number.isSafeInteger(arg.offset)).toBe(true);
    expect(Number.isSafeInteger(arg.limit)).toBe(true);
    expect(arg.offset).toBe(expOffset);
    expect(arg.limit).toBe(expSize);
    expect((await res.json()).page).toBe(expPage);
  });

  it("clamps an absurd pageSize instead of handing it to LIMIT", async () => {
    const { GET } = await import("@/app/api/v1/admin/api-keys/route");
    await GET(req("/api/v1/admin/api-keys", "pageSize=1e400"));
    const arg = listApiKeysAdmin.mock.calls[0]?.[0] as { limit: number };
    expect(arg.limit).toBeLessThanOrEqual(200);
    expect(Number.isSafeInteger(arg.limit)).toBe(true);
  });
});

describe("GET /api/v1/admin/oauth-clients — query validation (#47)", () => {
  it.each([["1.5"], ["1e400"], ["-3"], ["abc"]])(
    "page=%s yields an integer LIMIT/OFFSET",
    async (page) => {
      const { GET } = await import("@/app/api/v1/admin/oauth-clients/route");
      const res = await GET(req("/api/v1/admin/oauth-clients", `page=${page}`));
      expect(res.status).toBe(200);
      const arg = listOauthClients.mock.calls[0]?.[0] as { limit: number; offset: number };
      expect(Number.isSafeInteger(arg.offset)).toBe(true);
      expect(Number.isSafeInteger(arg.limit)).toBe(true);
      expect(arg.offset).toBe(0);
    },
  );
});
