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
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

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
  updateExecute.mockClear();
  upsertExecute.mockClear();
  ({ POST } = await import("@/app/api/preferences/locale/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/preferences/locale", () => {
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
