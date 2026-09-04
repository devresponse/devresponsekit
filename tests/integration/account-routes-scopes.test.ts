import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as ProfileRouteModule from "@/app/api/account/profile/route";
import type * as PreferencesRouteModule from "@/app/api/account/preferences/route";

/**
 * Scope enforcement on the self-service Account API mutations (review #184).
 *
 * `PUT /api/account/preferences` and `PATCH /api/account/profile` are gated by
 * `requireAccountUser(request, "account.<x>.write")`. A BEARER credential
 * (API key / JWT) must carry the matching write scope; a read-only
 * (`account.read`) or zero-scope key is refused with 403 `insufficient_scope`
 * BEFORE any write. Cookie sessions (`grantedScopes === null`) carry full
 * user authority and pass. The caller resolver is mocked so we can hand the
 * REAL guard an arbitrary credential; db / audit / Better Auth are stubbed.
 */
const resolveCaller = vi.fn();
const hasBearerCredential = vi.fn();
const auditMock = vi.fn();
const updateUserMock = vi.fn();
const updateSets: Record<string, unknown>[] = [];
const insertValues: Record<string, unknown>[] = [];

vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...a: unknown[]) => resolveCaller(...a),
  hasBearerCredential: (...a: unknown[]) => hasBearerCredential(...a),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { updateUser: (...args: unknown[]) => updateUserMock(...args) } },
}));
vi.mock("@/db/database", () => ({
  db: {
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        insertValues.push(v);
        return { onConflict: () => ({ execute: async () => undefined }) };
      },
    }),
  },
}));

const ACCESS = {
  appUserId: "app-self-1111",
  primaryEmail: "self@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

/** A resolved caller; `grantedScopes: null` models a cookie session. */
function caller(grantedScopes: string[] | null) {
  const bearer = grantedScopes !== null;
  return {
    kind: bearer ? "api_key" : "session",
    betterAuthUserId: "ba-self",
    access: ACCESS,
    grantedScopes,
    isBearer: bearer,
    credentialId: bearer ? "key-1" : null,
  };
}

function makeReq(body: unknown, method: string, bearer: boolean): NextRequest {
  const url = new URL("http://test.local/api/account/x");
  const headers = new Headers({ origin: "http://test.local" });
  if (bearer) headers.set("authorization", "Bearer drk_test_x.secret");
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

const PREFS_BODY = {
  preferredLocale: "en",
  timeZone: "UTC",
  dateFormat: "system",
  numberFormatLocale: "system",
};

let profilePATCH: typeof ProfileRouteModule.PATCH;
let preferencesPUT: typeof PreferencesRouteModule.PUT;

beforeEach(async () => {
  for (const m of [resolveCaller, hasBearerCredential, auditMock, updateUserMock]) m.mockReset();
  updateSets.length = 0;
  insertValues.length = 0;
  hasBearerCredential.mockImplementation((h: Headers) => h.has("authorization"));
  updateUserMock.mockResolvedValue({});
  ({ PATCH: profilePATCH } = await import("@/app/api/account/profile/route"));
  ({ PUT: preferencesPUT } = await import("@/app/api/account/preferences/route"));
});
afterEach(() => vi.resetModules());

async function expectInsufficientScope(res: Response) {
  expect(res.status).toBe(403);
  expect((await res.json()) as { error: string }).toMatchObject({ error: "insufficient_scope" });
}

describe("PUT /api/account/preferences — bearer scope gate (review #184)", () => {
  it("403 insufficient_scope for a read-only key (account.read) — nothing written", async () => {
    resolveCaller.mockResolvedValue(caller(["account.read"]));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", true));
    await expectInsufficientScope(res);
    expect(updateSets).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("403 insufficient_scope for a zero-scope key — nothing written", async () => {
    resolveCaller.mockResolvedValue(caller([]));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", true));
    await expectInsufficientScope(res);
    expect(updateSets).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it("does NOT accept the sibling write scope (account.profile.write)", async () => {
    resolveCaller.mockResolvedValue(caller(["account.profile.write"]));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", true));
    await expectInsufficientScope(res);
    expect(updateSets).toHaveLength(0);
  });

  it("200 for a key carrying account.preferences.write", async () => {
    resolveCaller.mockResolvedValue(caller(["account.preferences.write"]));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", true));
    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(insertValues).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.preferences.updated", outcome: "success" }),
    );
  });

  it("200 for the account.* wildcard", async () => {
    resolveCaller.mockResolvedValue(caller(["account.*"]));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", true));
    expect(res.status).toBe(200);
  });

  it("cookie session (null scopes) keeps full user authority", async () => {
    resolveCaller.mockResolvedValue(caller(null));
    const res = await preferencesPUT(makeReq(PREFS_BODY, "PUT", false));
    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
  });
});

describe("PATCH /api/account/profile — bearer scope gate (review #184)", () => {
  it("403 insufficient_scope for a read-only key — Better Auth never called", async () => {
    resolveCaller.mockResolvedValue(caller(["account.read"]));
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH", true));
    await expectInsufficientScope(res);
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(updateSets).toHaveLength(0);
  });

  it("403 insufficient_scope for a zero-scope key", async () => {
    resolveCaller.mockResolvedValue(caller([]));
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH", true));
    await expectInsufficientScope(res);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("does NOT accept the sibling write scope (account.preferences.write)", async () => {
    resolveCaller.mockResolvedValue(caller(["account.preferences.write"]));
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH", true));
    await expectInsufficientScope(res);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("200 for a key carrying account.profile.write", async () => {
    resolveCaller.mockResolvedValue(caller(["account.profile.write"]));
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH", true));
    expect(res.status).toBe(200);
    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateSets).toHaveLength(1);
  });

  it("cookie session (null scopes) keeps full user authority", async () => {
    resolveCaller.mockResolvedValue(caller(null));
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH", false));
    expect(res.status).toBe(200);
  });
});
