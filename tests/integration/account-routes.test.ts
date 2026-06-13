import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ProfileRouteModule from "@/app/api/account/profile/route";
import type * as PreferencesRouteModule from "@/app/api/account/preferences/route";

/**
 * Integration tests for the self-service Account API (`/api/account/*`).
 *
 * The central security property under test is STRICT SELF-SCOPING: every
 * write targets the SESSION user's own row, the routes never accept an id
 * from the body (strict Zod rejects it), and unauthenticated / non-member
 * callers are refused.
 */
const SESSION_BA_ID = "ba-self";
const SESSION_APP_ID = "app-self-1111";

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const updateUserMock = vi.fn();

const updateSets: Record<string, unknown>[] = [];
const updateWheres: Array<[unknown, unknown, unknown]> = [];
const insertValues: Record<string, unknown>[] = [];

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
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
        return {
          where: (col: unknown, op: unknown, val: unknown) => {
            updateWheres.push([col, op, val]);
            return { execute: async () => undefined };
          },
        };
      },
    }),
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        insertValues.push(v);
        return {
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        };
      },
    }),
  },
}));

function makeReq(body: unknown, method: string): NextRequest {
  const url = new URL("http://test.local/api/account/x");
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ origin: "http://test.local" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const ACTIVE_ACCESS = {
  appUserId: SESSION_APP_ID,
  primaryEmail: "self@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

let profilePATCH: typeof ProfileRouteModule.PATCH;
let preferencesPUT: typeof PreferencesRouteModule.PUT;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock, updateUserMock]) m.mockReset();
  updateSets.length = 0;
  updateWheres.length = 0;
  insertValues.length = 0;
  sessionGetter.mockResolvedValue({ user: { id: SESSION_BA_ID } });
  accessGetter.mockResolvedValue(ACTIVE_ACCESS);
  updateUserMock.mockResolvedValue({});
  ({ PATCH: profilePATCH } = await import("@/app/api/account/profile/route"));
  ({ PUT: preferencesPUT } = await import("@/app/api/account/preferences/route"));
});
afterEach(() => vi.resetModules());

describe("PATCH /api/account/profile", () => {
  it("401 when unauthenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH"));
    expect(res.status).toBe(401);
  });

  it("403 when not an active member", async () => {
    accessGetter.mockResolvedValue({ ...ACTIVE_ACCESS, membershipStatus: "pending_approval" });
    const res = await profilePATCH(makeReq({ name: "Ada" }, "PATCH"));
    expect(res.status).toBe(403);
  });

  it("400 on an empty name", async () => {
    const res = await profilePATCH(makeReq({ name: "" }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("updates the SESSION user's own row and the Better Auth name, then audits", async () => {
    const res = await profilePATCH(makeReq({ name: "Ada", displayName: "ada" }, "PATCH"));
    expect(res.status).toBe(200);
    // Better Auth name updated for the current session (no userId in body).
    expect(updateUserMock).toHaveBeenCalledWith(expect.objectContaining({ body: { name: "Ada" } }));
    // app_users update is scoped to the SESSION's appUserId.
    expect(updateWheres[0]).toEqual(["id", "=", SESSION_APP_ID]);
    expect(updateSets[0]).toMatchObject({ display_name: "ada" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.profile.updated", outcome: "success" }),
    );
  });

  it("IDOR: rejects a body carrying another user's id (strict schema) and never targets it", async () => {
    const res = await profilePATCH(
      makeReq({ name: "Ada", appUserId: "victim", userId: "victim", id: "victim" }, "PATCH"),
    );
    expect(res.status).toBe(400);
    expect(updateWheres).toHaveLength(0);
    expect(updateUserMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/account/preferences", () => {
  const valid = {
    preferredLocale: "fr",
    timeZone: "Europe/Kyiv",
    dateFormat: "iso8601",
    numberFormatLocale: "fr",
  };

  it("401 when unauthenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await preferencesPUT(makeReq(valid, "PUT"));
    expect(res.status).toBe(401);
  });

  it("400 on an unsupported locale", async () => {
    const res = await preferencesPUT(makeReq({ ...valid, preferredLocale: "zz" }, "PUT"));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid date format", async () => {
    const res = await preferencesPUT(makeReq({ ...valid, dateFormat: "nope" }, "PUT"));
    expect(res.status).toBe(400);
  });

  it("400 on an unknown time zone", async () => {
    const res = await preferencesPUT(makeReq({ ...valid, timeZone: "Mars/Base" }, "PUT"));
    expect(res.status).toBe(400);
  });

  it("upserts preferences for the SESSION user only, then audits", async () => {
    const res = await preferencesPUT(makeReq(valid, "PUT"));
    expect(res.status).toBe(200);
    // app_users.preferred_locale update scoped to the session app user.
    expect(updateWheres[0]).toEqual(["id", "=", SESSION_APP_ID]);
    // The upsert row is keyed to the session app user, never the body.
    expect(insertValues[0]).toMatchObject({
      app_user_id: SESSION_APP_ID,
      locale: "fr",
      time_zone: "Europe/Kyiv",
      date_format: "iso8601",
      number_format_locale: "fr",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.preferences.updated", outcome: "success" }),
    );
  });

  it("IDOR: a body app_user_id is rejected and never used as the upsert key", async () => {
    const res = await preferencesPUT(makeReq({ ...valid, app_user_id: "victim" }, "PUT"));
    expect(res.status).toBe(400);
    expect(insertValues).toHaveLength(0);
  });

  it("normalizes a 'system' number format to NULL", async () => {
    const res = await preferencesPUT(makeReq({ ...valid, numberFormatLocale: "system" }, "PUT"));
    expect(res.status).toBe(200);
    expect(insertValues[0]).toMatchObject({ number_format_locale: null });
  });
});
