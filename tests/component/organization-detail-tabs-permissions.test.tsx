// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-69: the organization detail tabs hand each panel the flag of the key its
 * routes gate on. The members grid, the invitations panel and the providers
 * grid write through routes on `admin.orgs.manage` (`canManage`); the
 * Authentication policy through routes on `admin.orgs.update` (`canUpdate`).
 * One `canUpdate` used to drive all four, so a settings-only role saw Remove,
 * Invite and Unbind buttons whose every click answered 403, and a people-only
 * role saw none of them.
 *
 * The panels are stubbed to record the props they are given; the real tab
 * container runs.
 */
const received = vi.hoisted(() => ({}) as Record<string, { canUpdate?: boolean }>);

vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-members-grid",
  () => ({
    OrganizationMembersGrid: (props: { canUpdate: boolean }) => {
      received.members = props;
      return <p>members panel</p>;
    },
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel",
  () => ({
    OrganizationInvitationsPanel: (props: { canUpdate: boolean }) => {
      received.invitations = props;
      return null;
    },
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-providers-grid",
  () => ({
    OrganizationProvidersGrid: (props: { canUpdate: boolean }) => {
      received.providers = props;
      return <p>providers panel</p>;
    },
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-settings-form",
  () => ({ OrganizationSettingsForm: () => null }),
);
vi.mock("@/components/admin/auth-policy-form", () => ({
  AuthPolicyForm: (props: { canUpdate: boolean }) => {
    received.authPolicy = props;
    return null;
  },
}));

import { OrganizationDetailTabs } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-detail-tabs";

const ORG = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  status: "active",
  isDefault: false,
  isResolvedDefault: false,
  memberCount: 3,
  bindingCount: 1,
};

async function render(flags: { canManage: boolean; canUpdate: boolean }) {
  const user = userEvent.setup();
  renderWithIntl(
    <OrganizationDetailTabs
      org={ORG}
      {...flags}
      canEditSettings={false}
      canReadRoles
      canReadUsers
      authSettings={null}
      platformAuthDefaults={null}
    />,
  );
  expect(screen.getByText("members panel")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Providers" }));
  expect(await screen.findByText("providers panel")).toBeInTheDocument();
}

beforeEach(() => {
  for (const key of Object.keys(received)) delete received[key];
});

describe("organization detail tabs — each panel's write flag follows its routes' key (F-69)", () => {
  it("a settings-only viewer (admin.orgs.update) gets the Authentication form, not the people panels", async () => {
    await render({ canManage: false, canUpdate: true });
    expect(received.members?.canUpdate).toBe(false);
    expect(received.invitations?.canUpdate).toBe(false);
    expect(received.providers?.canUpdate).toBe(false);
    expect(received.authPolicy?.canUpdate).toBe(true);
  });

  it("a people-only viewer (admin.orgs.manage) gets the people panels, not the Authentication form", async () => {
    await render({ canManage: true, canUpdate: false });
    expect(received.members?.canUpdate).toBe(true);
    expect(received.invitations?.canUpdate).toBe(true);
    expect(received.providers?.canUpdate).toBe(true);
    expect(received.authPolicy?.canUpdate).toBe(false);
  });
});
