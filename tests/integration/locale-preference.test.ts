import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LocaleRouteModule from "@/app/api/preferences/locale/route";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for `/api/preferences/locale` (§29.6.12).
 *
 * The route is exercised end-to-end at the Next.js handler level with
 * the database, audit module, and auth-guard mocked out. This proves the
 * authorization + validation + audit ordering without standing up a
 * Postgres instance. DB-state assertions are covered by the dedicated
 * SQL integration suite that runs against the seeded test database.
 *
 * Since review #28 the route authenticates through the shared self-service
 * guard (`requireAccountUser`, run for real here — only the session and
 * access lookups beneath it are mocked) and is rate-limited per user.
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const originCheck = vi.fn();

// The CSRF origin guard short-circuits under NODE_ENV=test, so it is mocked
// here to drive the deny path (its matching logic has its own unit suite).
vi.mock("@/lib/admin/origin-guard.server", () => ({
  checkTrustedOrigin: (...a: unknown[]) => originCheck(...a),
}));

const updateExecute = vi.fn().mockResolvedValue(undefined);
const upsertExecute = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

// Minimal Kysely query-builder stub matching the chain used by the route.
const dbStub = {
  updateTable: () => ({
    set: () => ({
      where: () => ({ execute: updateExecute }),
    }),
  }),
  insertInto: () => ({
    values: () => ({
      onConflict: () => ({ execute: upsertExecute }),
    }),
  }),
};
vi.mock("@/db/database", () => ({ db: dbStub }));

function makeRequest(body: unknown): NextRequest {
  // The route only calls .json(), so a minimal Request shape is enough.
  return {
    json: async () => body,
    headers: new Headers(),
  } as unknown as NextRequest;
}

let POST: typeof LocaleRouteModule.POST;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  originCheck.mockReset().mockReturnValue({ ok: true });
  updateExecute.mockClear();
  upsertExecute.mockClear();
  ({ POST } = await import("@/app/api/preferences/locale/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/preferences/locale", () => {
  it("returns 403 untrusted_origin on a cross-origin request BEFORE touching the session (review #39/#188)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "untrusted_origin" });
    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "untrusted_origin" });
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(updateExecute).not.toHaveBeenCalled();
    expect(upsertExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 403 when neither Origin nor Referer is present (missing_origin)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "missing_origin" });
    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(403);
    expect(updateExecute).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(401);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is blocked", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "blocked",
      organizationId: "o-1",
      membershipStatus: "blocked",
      preferredLocale: "en",
      permissions: [],
    });
    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 for a pending user — the shared guard admits ACTIVE members only (review #28)", async () => {
    // The only client that persists a locale is the secure shell's switcher,
    // which a pending user never reaches; the (auth)-layout switcher just
    // changes the URL locale. So the guard's active-member rule costs nothing
    // for real traffic and removes a bespoke "pending may write" carve-out.
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "pending_approval",
      organizationId: null,
      membershipStatus: null,
      preferredLocale: "en",
      permissions: [],
    });
    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "forbidden" });
    expect(updateExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("throttles a scripted locale loop per user with 429 + Retry-After, before any write (review #28)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
    });
    // DEFAULT_ADMIN_MUTATION_LIMIT: 30-token burst.
    for (let i = 0; i < 30; i += 1) {
      expect((await POST(makeRequest({ locale: "fr" }))).status).toBe(200);
    }
    updateExecute.mockClear();
    auditMock.mockClear();
    const denied = await POST(makeRequest({ locale: "fr" }));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(updateExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "i18n.locale.changed" }),
    );
  });

  it("returns 400 for an unsupported locale", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
    });
    const res = await POST(makeRequest({ locale: "zz" }));
    expect(res.status).toBe(400);
  });

  it("persists and audits a valid locale change", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
    });

    const res = await POST(makeRequest({ locale: "fr" }));
    expect(res.status).toBe(200);
    expect(updateExecute).toHaveBeenCalledTimes(1);
    expect(upsertExecute).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      eventType: "i18n.locale.changed",
      outcome: "success",
      metadata: { locale: "fr" },
    });
  });

  it("returns 400 on malformed JSON without writing to the database", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
    });
    const badReq = {
      json: async () => {
        throw new Error("bad json");
      },
      headers: new Headers(),
    } as unknown as NextRequest;
    const res = await POST(badReq);
    expect(res.status).toBe(400);
    expect(updateExecute).not.toHaveBeenCalled();
  });
});
