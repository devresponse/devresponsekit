import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as Route from "@/app/api/v1/me/api-keys/route";

/**
 * /api/v1/me/api-keys — self-service key issuance (was 0% covered).
 * The security contract: a caller may only mint a key carrying scopes it
 * itself holds — a credential can never mint a BROADER credential than
 * itself (design §7). The real scope helpers run; the guard + repo are
 * mocked.
 */
const requireApiAccount = vi.fn();
const listApiKeysForUser = vi.fn();
const createApiKey = vi.fn();
const auditEvent = vi.fn();

// The v1 self-service routes gate on `requireApiAccount` — the problem+json
// rendering of the same account decision (review #45).
vi.mock("@/lib/account/guard.server", () => ({
  requireApiAccount: (...a: unknown[]) => requireApiAccount(...a),
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  listApiKeysForUser: (...a: unknown[]) => listApiKeysForUser(...a),
  createApiKey: (...a: unknown[]) => createApiKey(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ API_KEY_DEFAULT_TTL_DAYS: null }) }));

function req(init?: { method?: string; body?: unknown }): NextRequest {
  const url = "http://test.local/api/v1/me/api-keys";
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}

/** actor with explicit caller authority. grantedScopes null = cookie session. */
function actor(opts: { permissions: string[]; grantedScopes: string[] | null }) {
  return {
    ok: true,
    actor: {
      appUserId: "u1",
      betterAuthUserId: "ba1",
      grantedScopes: opts.grantedScopes,
      access: { permissions: opts.permissions, organizationId: "o1" },
    },
  };
}

let GET: typeof Route.GET;
let POST: typeof Route.POST;

beforeEach(async () => {
  for (const m of [requireApiAccount, listApiKeysForUser, createApiKey, auditEvent]) m.mockReset();
  listApiKeysForUser.mockResolvedValue([{ id: "k1", name: "k", key_prefix: "drk_live_x" }]);
  createApiKey.mockResolvedValue({
    id: "k-new",
    name: "n",
    key_prefix: "drk_live_y",
    scopes: ["account.read"],
    expires_at: null,
    plaintext: "drk_live_y.SECRET",
  });
  ({ GET, POST } = await import("@/app/api/v1/me/api-keys/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/me/api-keys", () => {
  it("returns the guard's response when denied", async () => {
    const { NextResponse } = await import("next/server");
    requireApiAccount.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    expect((await GET(req())).status).toBe(401);
  });

  it("lists only the CALLER'S OWN keys (self-scoped by appUserId)", async () => {
    requireApiAccount.mockResolvedValue(
      actor({ permissions: ["account.read"], grantedScopes: null }),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(listApiKeysForUser).toHaveBeenCalledWith("u1");
  });
});

describe("POST /api/v1/me/api-keys — self-ownership of scopes", () => {
  it("400 on an invalid body (strict schema)", async () => {
    requireApiAccount.mockResolvedValue(
      actor({ permissions: ["account.apikeys.manage"], grantedScopes: null }),
    );
    const res = await POST(req({ method: "POST", body: { name: "", scopes: [] } }));
    expect(res.status).toBe(400);
  });

  it("403 invalid_scope when a cookie caller requests an admin scope it does NOT hold", async () => {
    requireApiAccount.mockResolvedValue(
      actor({ permissions: ["account.apikeys.manage"], grantedScopes: null }),
    );
    const res = await POST(
      req({ method: "POST", body: { name: "k", scopes: ["admin.users.read"] } }),
    );
    expect(res.status).toBe(403);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("403 when a BEARER caller mints a key broader than its own granted scopes", async () => {
    // The calling credential only holds account.read; it cannot mint a key
    // that can manage api keys.
    requireApiAccount.mockResolvedValue(
      actor({
        permissions: ["account.apikeys.manage", "account.read"],
        grantedScopes: ["account.read"],
      }),
    );
    const res = await POST(
      req({ method: "POST", body: { name: "k", scopes: ["account.apikeys.manage"] } }),
    );
    expect(res.status).toBe(403);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("201 and returns the plaintext ONCE for a self-grantable account scope", async () => {
    requireApiAccount.mockResolvedValue(
      actor({ permissions: ["account.apikeys.manage"], grantedScopes: null }),
    );
    const res = await POST(req({ method: "POST", body: { name: "k", scopes: ["account.read"] } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; id: string };
    expect(body.key).toBe("drk_live_y.SECRET");
    expect(createApiKey).toHaveBeenCalledWith(expect.objectContaining({ ownerAppUserId: "u1" }));
  });

  // sec-2: credential minting is throttled per principal. Drain the burst
  // (capacity 30) then prove the next call is rejected 429 before any key is
  // minted. The bucket is reset first so prior cases don't skew the count.
  it("429 rate-limits minting once the per-actor burst is exhausted", async () => {
    const rl = await import("@/lib/admin/rate-limit.server");
    rl.__resetRateLimitForTests();
    requireApiAccount.mockResolvedValue(
      actor({ permissions: ["account.apikeys.manage"], grantedScopes: null }),
    );
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await POST(req({ method: "POST", body: { name: "k", scopes: ["account.read"] } }));
    }
    expect(last?.status).toBe(429);
    // The throttled 31st request never reached the key repository.
    expect(createApiKey).toHaveBeenCalledTimes(30);
  });
});
