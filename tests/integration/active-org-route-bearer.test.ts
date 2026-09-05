import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as RouteModule from "@/app/api/preferences/active-org/route";

/**
 * Bearer callers on `POST /api/preferences/active-org` (review #28, MACHINE-1).
 *
 * Routing the switch through the shared self-service guard would ADMIT an API
 * key / JWT carrying `account.preferences.write` — a caller the route never
 * accepted before (it authenticated only via the session cookie) and one for
 * which "active org" is meaningless: a minted credential is bound to its
 * tenant and never reads the cookie. The route must refuse such a caller with
 * 403 and set no cookie. The caller resolver is mocked so the REAL guard is
 * handed a resolved bearer principal.
 */
const resolveCaller = vi.fn();
const hasBearerCredential = vi.fn();
const hasMembership = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...a: unknown[]) => resolveCaller(...a),
  hasBearerCredential: (...a: unknown[]) => hasBearerCredential(...a),
}));
vi.mock("@/lib/active-org.server", () => ({
  ACTIVE_ORG_COOKIE: "active_org",
  userHasActiveMembership: (...a: unknown[]) => hasMembership(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active",
  organizationId: "o-bound",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

function caller(kind: "api_key" | "jwt" | "session", grantedScopes: string[] | null) {
  const bearer = kind !== "session";
  return {
    kind,
    betterAuthUserId: "ba-1",
    access: ACCESS,
    grantedScopes,
    isBearer: bearer,
    credentialId: bearer ? "cred-1" : null,
    impersonatorId: null,
  };
}

function req(bearer: boolean): NextRequest {
  const headers = new Headers({ origin: "http://localhost:3000" });
  if (bearer) headers.set("authorization", "Bearer drk_test_x.secret");
  return {
    json: async () => ({ organizationId: ORG_ID }),
    headers,
    method: "POST",
  } as unknown as NextRequest;
}

let POST: typeof RouteModule.POST;

beforeEach(async () => {
  for (const m of [resolveCaller, hasBearerCredential, hasMembership, auditMock]) m.mockReset();
  hasBearerCredential.mockImplementation((h: Headers) => h.has("authorization"));
  hasMembership.mockResolvedValue(true);
  ({ POST } = await import("@/app/api/preferences/active-org/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/preferences/active-org — bearer callers (review #28)", () => {
  it.each(["api_key", "jwt"] as const)(
    "refuses a resolved %s caller with 403 even when it carries account.preferences.write",
    async (kind) => {
      resolveCaller.mockResolvedValue(caller(kind, ["account.preferences.write"]));
      const res = await POST(req(true));
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: string }).toMatchObject({ error: "forbidden" });
      expect(res.cookies.get("active_org")).toBeUndefined();
      expect(hasMembership).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it("still lets the same guard admit a cookie session (the refusal is about the credential kind, not the scope)", async () => {
    resolveCaller.mockResolvedValue(caller("session", null));
    const res = await POST(req(false));
    expect(res.status).toBe(200);
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    expect(hasMembership).toHaveBeenCalledWith("u-1", ORG_ID);
  });
});
