import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * GET /api/account/export (F-151): the caller's own data-subject export.
 *
 * The guard is mocked (its IMP-1, origin and status decisions are covered by
 * account-routes-scopes.test.ts) and so is the document builder, which has
 * its own unit suite and the DB-backed proof in
 * tests/db/user-data-export-erasure.db.test.ts. What is pinned here is the
 * route's contract: self-scoped (the builder gets the guard's `appUserId`,
 * never anything from the request), cookie sessions only (a bearer caller is
 * refused and the refusal audited), rate-limited on the export tier, audited
 * with counts but no data, and served as an attachment that is never cached.
 */
const requireAccountUser = vi.fn();
const auditMock = vi.fn();
const buildUserDataExport = vi.fn();

vi.mock("@/lib/account/guard.server", () => ({
  requireAccountUser: (...a: unknown[]) => requireAccountUser(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/user-data/export.server", () => ({
  buildUserDataExport: (...a: unknown[]) => buildUserDataExport(...a),
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

const DOC = {
  format: "devresponse.user-data-export",
  version: 1,
  generatedAt: "2026-09-29T12:00:00.000Z",
  organizationScope: null,
  profile: { appUserId: "app-self", primaryEmail: "self@x.com" },
  memberships: [{ organizationId: "o-1" }],
  roles: [],
  groups: [],
  linkedAccounts: [],
  sessions: [{ ipAddress: "192.0.2.1" }],
  apiKeys: [],
  oauthClients: [],
  invitations: [],
  auditEvents: [{ id: "e-1" }, { id: "e-2" }],
  auditEventsTruncated: false,
};

function makeReq(): NextRequest {
  const url = new URL("http://test.local/api/account/export?appUserId=someone-else");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

let GET: (r: NextRequest) => Promise<Response>;

beforeEach(async () => {
  for (const m of [requireAccountUser, auditMock, buildUserDataExport]) m.mockReset();
  requireAccountUser.mockResolvedValue({ ok: true, actor: ACTOR });
  buildUserDataExport.mockResolvedValue(DOC);
  const { __resetRateLimitForTests } = await import("@/lib/admin/rate-limit.server");
  __resetRateLimitForTests();
  ({ GET } = await import("@/app/api/account/export/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/account/export (F-151)", () => {
  it("serves the caller's own document as an uncached attachment, and audits the counts", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    // Self-scoped: the guard's id, not the query string's.
    expect(buildUserDataExport).toHaveBeenCalledWith("app-self");
    expect(requireAccountUser).toHaveBeenCalledWith(expect.anything(), "account.read");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="user-data-app-self-20260929.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(await res.json()).toEqual(DOC);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const row = auditMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      eventType: "account.data_exported",
      outcome: "success",
      actorBetterAuthUserId: "ba-self",
      appUserId: "app-self",
      metadata: {
        counts: expect.objectContaining({ memberships: 1, sessions: 1, auditEvents: 2 }),
        auditEventsTruncated: false,
      },
    });
    // Counts only: none of the exported values reach the audit row.
    expect(JSON.stringify(row)).not.toContain("192.0.2.1");
  });

  it("returns the guard's refusal untouched (unauthenticated, impersonated, blocked)", async () => {
    const refusal = new Response(null, { status: 403 });
    requireAccountUser.mockResolvedValue({ ok: false, response: refusal });
    const res = await GET(makeReq());
    expect(res).toBe(refusal);
    expect(buildUserDataExport).not.toHaveBeenCalled();
  });

  it.each(["api_key", "jwt"] as const)(
    "refuses a %s caller with 403 and a denied row: the whole account is a cookie session's to take",
    async (callerKind) => {
      requireAccountUser.mockResolvedValue({
        ok: true,
        actor: { ...ACTOR, callerKind, credentialId: "cred-1", grantedScopes: ["account.read"] },
      });
      const res = await GET(makeReq());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
      expect(buildUserDataExport).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "account.access.denied",
          outcome: "denied",
          reason: "session_required",
          metadata: { action: "data_export", callerKind },
        }),
      );
    },
  );

  it("is rate-limited on the export tier (3 burst per user)", async () => {
    for (let i = 0; i < 3; i++) expect((await GET(makeReq())).status).toBe(200);
    const limited = await GET(makeReq());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(buildUserDataExport).toHaveBeenCalledTimes(3);
  });

  it("answers 404 when the account row is gone", async () => {
    buildUserDataExport.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
