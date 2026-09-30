import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PageModule from "@/app/[locale]/(secure)/app/account/page";

/**
 * F-65 — /app/account under IMPERSONATION shows only the organizations the
 * borrowed session can resolve.
 *
 * The overview lists the user's memberships and roles. During an impersonation
 * the user is the borrowed identity, who may belong to tenants the admin cannot
 * reach: the IMP-1 confinement keeps the session out of them, but this page
 * listed them anyway, with each org's name, the membership status and the names
 * of the roles held there. The admin API refuses the same information (404, or
 * rows filtered to the admin's org).
 *
 * This runs the real page with its collaborators stubbed and pins the hand-off:
 * the impersonator's reach, from the same helper the org switcher and the
 * resolver use, reaches `getAccountOverview`. The query's own filter is pinned
 * against Postgres in tests/db/account-overview-reach.db.test.ts.
 */
const requireSecureSession = vi.fn();
const listImpersonationReachableOrgIds = vi.fn();
const getAccountOverview = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/auth-guard", () => ({
  requireSecureSession: (...a: unknown[]) => requireSecureSession(...a),
  getImpersonatorId: (s: { session?: { impersonatedBy?: string } } | null) =>
    s?.session?.impersonatedBy ?? null,
}));
vi.mock("@/lib/impersonation-reach.server", () => ({
  listImpersonationReachableOrgIds: (...a: unknown[]) => listImpersonationReachableOrgIds(...a),
}));
vi.mock("@/lib/format/viewer-format.server", () => ({
  getAppFormatter: async () => ({ date: () => "2026-01-01" }),
}));
vi.mock("@/app/[locale]/(secure)/app/account/_data.server", () => ({
  getAccountOverview: (...a: unknown[]) => getAccountOverview(...a),
}));

const ACCESS = {
  appUserId: "u-target",
  primaryEmail: "target@x.com",
  status: "active",
  organizationId: "org-a",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};
const OVERVIEW = {
  displayName: null,
  primaryEmail: "target@x.com",
  status: "active",
  statusReason: null,
  preferredLocale: "en",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  memberships: [],
  roles: [],
};

let Page: typeof PageModule.default;
const params = { params: Promise.resolve({ locale: "en" }) };

beforeEach(async () => {
  for (const m of [requireSecureSession, listImpersonationReachableOrgIds, getAccountOverview]) {
    m.mockReset();
  }
  getAccountOverview.mockResolvedValue(OVERVIEW);
  ({ default: Page } = await import("@/app/[locale]/(secure)/app/account/page"));
});
afterEach(() => vi.resetModules());

describe("/app/account overview — organizations shown (F-65)", () => {
  it("limits an impersonated session to the impersonator's reach", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: { impersonatedBy: "ba-admin" } },
      access: ACCESS,
    });
    listImpersonationReachableOrgIds.mockResolvedValue(["org-a"]);

    await Page(params);

    expect(listImpersonationReachableOrgIds).toHaveBeenCalledWith("ba-admin");
    expect(getAccountOverview).toHaveBeenCalledWith("u-target", ["org-a"]);
  });

  it("passes an empty reach through as empty, never as 'unconfined'", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: { impersonatedBy: "ba-admin" } },
      access: ACCESS,
    });
    listImpersonationReachableOrgIds.mockResolvedValue([]);

    await Page(params);

    expect(getAccountOverview).toHaveBeenCalledWith("u-target", []);
  });

  it("shows every org to a superadmin impersonator, whose reach is unconfined (null)", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: { impersonatedBy: "ba-root" } },
      access: ACCESS,
    });
    listImpersonationReachableOrgIds.mockResolvedValue(null);

    await Page(params);

    expect(getAccountOverview).toHaveBeenCalledWith("u-target", null);
  });

  it("shows every org to a user acting as themselves, without asking for a reach", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: {} },
      access: ACCESS,
    });

    await Page(params);

    expect(listImpersonationReachableOrgIds).not.toHaveBeenCalled();
    expect(getAccountOverview).toHaveBeenCalledWith("u-target", null);
  });
});

/**
 * F-151: the person's own data-subject export is offered on the overview as a
 * plain link to `GET /api/account/export`. The route refuses an impersonated
 * session (IMP-1), so the page does not offer the link there.
 */
describe("/app/account overview — data export link (F-151)", () => {
  function hrefs(node: unknown, out: string[] = []): string[] {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const child of node) hrefs(child, out);
      return out;
    }
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) {
      if (typeof props.href === "string") out.push(props.href);
      hrefs(props.children, out);
    }
    return out;
  }

  it("links the export for a user acting as themselves", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: {} },
      access: ACCESS,
    });
    expect(hrefs(await Page(params))).toContain("/api/account/export");
  });

  it("does not offer it to an impersonated session", async () => {
    requireSecureSession.mockResolvedValue({
      session: { user: { id: "ba-target" }, session: { impersonatedBy: "ba-admin" } },
      access: ACCESS,
    });
    listImpersonationReachableOrgIds.mockResolvedValue(null);
    expect(hrefs(await Page(params))).not.toContain("/api/account/export");
  });
});
