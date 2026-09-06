// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  UserDetailTabs,
  type UserDetailJson,
} from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-detail-tabs";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Overview tab rendering of `deactivated_by` (review #212): a raw Better
 * Auth user id told the reader nothing about WHO deactivated the account.
 * The RSC resolves it; this pins that the tab prefers the resolved label
 * and still degrades to the id when resolution failed.
 */
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-sessions-panel", () => ({
  UserSessionsPanel: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-memberships-panel", () => ({
  UserMembershipsPanel: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-roles-panel", () => ({
  UserRolesPanel: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-groups-panel", () => ({
  UserGroupsPanel: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-audit-panel", () => ({
  UserAuditPanel: () => null,
}));

const BASE: UserDetailJson = {
  id: "11111111-1111-4111-8111-111111111111",
  better_auth_user_id: "ba-target",
  primary_email: "target@x.com",
  display_name: null,
  status: "deactivated",
  status_reason: null,
  preferred_locale: "en",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  deactivated_at: "2026-02-03T00:00:00.000Z",
  deactivated_by: "ba-admin-7",
  deactivated_by_label: null,
  deactivated_reason: null,
};

function render(user: UserDetailJson) {
  return renderWithIntl(
    <UserDetailTabs
      user={user}
      canAssignRoles={false}
      canManageGroups={false}
      canUpdateMemberships={false}
      canReadAudit={false}
    />,
  );
}

describe("UserDetailTabs — deactivated_by (review #212)", () => {
  it("shows the resolved display name, not the Better Auth id", () => {
    render({ ...BASE, deactivated_by_label: "Grace Hopper" });
    expect(screen.getByText("Deactivated by Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText(/ba-admin-7/)).toBeNull();
  });

  it("falls back to the raw id when the actor could not be resolved", () => {
    render(BASE);
    expect(screen.getByText("Deactivated by ba-admin-7")).toBeInTheDocument();
  });
});
