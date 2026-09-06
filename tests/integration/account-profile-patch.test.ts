import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { APIError } from "better-auth/api";

/**
 * PATCH /api/account/profile — partial-update semantics and Better Auth error
 * mapping (review #185, #187).
 *
 *   - #187: PATCH is a PARTIAL update. `parsed.data.displayName ?? null` could
 *     not distinguish an OMITTED key from an explicit `null`, so a
 *     `{ "name": "…" }` PATCH silently wiped the caller's display name. The
 *     three cases — absent / null / value — are pinned here.
 *   - #185: a Better Auth `APIError` carries an HTTP status; reporting all of
 *     them as `502 update_failed` mislabels a client error as a gateway fault
 *     and writes an `outcome: "error"` audit row for it.
 *
 * The guard is mocked (its own behaviour is covered by
 * account-routes-scopes.test.ts); the DB update RECORDS the `set()` payload,
 * which is the thing under test.
 */
const requireAccountUser = vi.fn();
const auditMock = vi.fn();
const updateUserMock = vi.fn();
const adapterUpdateUserMock = vi.fn();
const updateSets: Record<string, unknown>[] = [];

vi.mock("@/lib/account/guard.server", () => ({
  requireAccountUser: (...a: unknown[]) => requireAccountUser(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { updateUser: (...a: unknown[]) => updateUserMock(...a) },
    $context: Promise.resolve({
      internalAdapter: { updateUser: (...a: unknown[]) => adapterUpdateUserMock(...a) },
    }),
  },
}));
vi.mock("@/db/database", () => ({
  db: {
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  },
}));

const ACTOR = {
  betterAuthUserId: "ba-self",
  appUserId: "app-self",
  callerKind: "session" as const,
  credentialId: null,
  grantedScopes: null,
  impersonatorId: null,
  access: {
    appUserId: "app-self",
    primaryEmail: "self@x.com",
    status: "active",
    organizationId: "o-1",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["shell.view"],
  },
};

function makeReq(body: unknown): NextRequest {
  const url = new URL("http://test.local/api/account/profile");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "PATCH",
    headers: new Headers({ origin: "http://test.local" }),
    json: async () => body,
  } as unknown as NextRequest;
}

let PATCH: (r: NextRequest) => Promise<Response>;

beforeEach(async () => {
  for (const m of [requireAccountUser, auditMock, updateUserMock, adapterUpdateUserMock]) {
    m.mockReset();
  }
  updateSets.length = 0;
  updateUserMock.mockResolvedValue({});
  adapterUpdateUserMock.mockResolvedValue({});
  requireAccountUser.mockResolvedValue({ ok: true, actor: ACTOR });
  ({ PATCH } = await import("@/app/api/account/profile/route"));
});
afterEach(() => vi.resetModules());

describe("review #187: absent vs null vs value for displayName", () => {
  it("OMITTED displayName leaves display_name untouched", async () => {
    const res = await PATCH(makeReq({ name: "Ada" }));
    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    // The column is not in the UPDATE at all — the stored value survives.
    expect(updateSets[0]).not.toHaveProperty("display_name");
    expect(updateSets[0]).toHaveProperty("updated_at");
    // The audit row names only the field that actually changed.
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      outcome: "success",
      metadata: { fields: ["name"] },
    });
  });

  it("explicit null CLEARS display_name", async () => {
    const res = await PATCH(makeReq({ name: "Ada", displayName: null }));
    expect(res.status).toBe(200);
    expect(updateSets[0]).toMatchObject({ display_name: null });
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      metadata: { fields: ["name", "displayName"] },
    });
  });

  it("a value SETS display_name (and is trimmed by the shared schema)", async () => {
    const res = await PATCH(makeReq({ name: "Ada", displayName: "  Ada L.  " }));
    expect(res.status).toBe(200);
    expect(updateSets[0]).toMatchObject({ display_name: "Ada L." });
  });

  it("an empty string still clears it to '' (unchanged, explicit intent)", async () => {
    await PATCH(makeReq({ name: "Ada", displayName: "" }));
    expect(updateSets[0]).toMatchObject({ display_name: "" });
  });
});

describe("review #185: Better Auth failures are mapped, not blanket-502'd", () => {
  it("maps a 4xx APIError to that status and writes NO error audit row", async () => {
    updateUserMock.mockRejectedValue(new APIError("BAD_REQUEST", { code: "INVALID_NAME" }));
    const res = await PATCH(makeReq({ name: "Ada" }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_body" });
    // A client error is not a service incident: no audit row, no stderr trace.
    expect(auditMock).not.toHaveBeenCalled();
    // …and nothing was written to the app row either.
    expect(updateSets).toHaveLength(0);
  });

  it("maps a 401 APIError to 401 unauthenticated", async () => {
    updateUserMock.mockRejectedValue(new APIError("UNAUTHORIZED"));
    const res = await PATCH(makeReq({ name: "Ada" }));
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unauthenticated" });
  });

  it("still reports a genuine 5xx as 502 and audits it with the stable code", async () => {
    updateUserMock.mockRejectedValue(
      new APIError("INTERNAL_SERVER_ERROR", { code: "DB_DOWN", message: "secret detail" }),
    );
    const res = await PATCH(makeReq({ name: "Ada" }));
    expect(res.status).toBe(502);
    const audited = auditMock.mock.calls[0]?.[0] as {
      outcome: string;
      metadata: Record<string, unknown>;
    };
    expect(audited.outcome).toBe("error");
    expect(audited.metadata).toMatchObject({ code: "DB_DOWN", status: 500 });
    // The exception TEXT never reaches the audit row or the response.
    expect(JSON.stringify(audited.metadata)).not.toContain("secret detail");
  });
});

describe("review #185: bearer callers do not go through the session endpoint", () => {
  it("writes the Better Auth name via the internal adapter", async () => {
    requireAccountUser.mockResolvedValue({
      ok: true,
      actor: {
        ...ACTOR,
        callerKind: "api_key",
        credentialId: "k1",
        grantedScopes: ["account.profile.write"],
      },
    });
    const res = await PATCH(makeReq({ name: "Ada", displayName: "Ada L." }));
    expect(res.status).toBe(200);
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(adapterUpdateUserMock).toHaveBeenCalledWith("ba-self", { name: "Ada" });
    expect(updateSets[0]).toMatchObject({ display_name: "Ada L." });
  });

  it("a JWT caller takes the same path", async () => {
    requireAccountUser.mockResolvedValue({
      ok: true,
      actor: {
        ...ACTOR,
        callerKind: "jwt",
        credentialId: "jti-1",
        grantedScopes: ["account.profile.write"],
      },
    });
    expect((await PATCH(makeReq({ name: "Ada" }))).status).toBe(200);
    expect(adapterUpdateUserMock).toHaveBeenCalledTimes(1);
  });
});
