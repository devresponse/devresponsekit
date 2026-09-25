// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-39: Radix Tabs unmount an inactive panel, so every tab switch remounts a
 * settings form from the props the page was rendered with. Nothing moved those
 * props after a save, and every save re-sent every field: a superadmin
 * suspended an org, looked at Members, came back to Settings (which showed
 * Active again), fixed a typo in the name and saved, and the org was silently
 * un-suspended. The role and group Settings tabs reverted a rename the same
 * way, the org Authentication tab showed "inherits the platform default" for
 * an org that had just been given its own sign-up policy, and the role
 * Permissions editor re-showed the pre-save set.
 *
 * These drive the REAL tab containers: a tab switch really unmounts and
 * remounts the panel. `rerender` with new props models the `router.refresh()`
 * landing (the RSC re-rendering the page with the saved state); a switch
 * WITHOUT a rerender models a remount that happens before it lands. The
 * sibling panels (grids, invitations) are stubbed; they fetch their own data
 * and are not under test.
 */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-members-grid",
  () => ({
    OrganizationMembersGrid: () => <p>members panel</p>,
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel",
  () => ({
    OrganizationInvitationsPanel: () => null,
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-providers-grid",
  () => ({
    OrganizationProvidersGrid: () => null,
  }),
);
vi.mock("@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-members-grid", () => ({
  RoleMembersGrid: () => <p>members panel</p>,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid", () => ({
  GroupMembersGrid: () => <p>members panel</p>,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor", () => ({
  GroupRolesEditor: () => <p>roles panel</p>,
}));

import {
  OrganizationDetailTabs,
  type OrganizationDetailJson,
} from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-detail-tabs";
import {
  RoleDetailTabs,
  type RoleDetailJson,
} from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-detail-tabs";
import {
  GroupDetailTabs,
  type GroupDetailJson,
} from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-detail-tabs";
import type { AuthPolicySettingsJson } from "@/components/admin/auth-policy-form";
import { pickChangedFields } from "@/lib/forms/use-saved-form-baseline";

const fetchMock = vi.fn();

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The bodies of every call with `method`, parsed, in order. */
function bodies(method: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === method)
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function switchAwayAndBack(
  user: ReturnType<typeof userEvent.setup>,
  away: string,
  back: string,
): Promise<void> {
  await user.click(screen.getByRole("tab", { name: away }));
  expect(await screen.findByText(/panel$/)).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: back }));
}

describe("organization Settings tab (F-39)", () => {
  const ORG: OrganizationDetailJson = {
    id: "o1",
    slug: "acme",
    name: "Acme Crop",
    status: "active",
    isDefault: false,
    memberCount: 3,
    bindingCount: 0,
  };
  const renderOrg = (org: OrganizationDetailJson) => (
    <OrganizationDetailTabs org={org} canUpdate authSettings={null} platformAuthDefaults={null} />
  );
  const status = () => screen.getByRole("combobox", { name: /^Status/ });
  const name = () => screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement;

  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
  });

  async function suspend(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(status());
    await user.click(await screen.findByRole("option", { name: "Suspended" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Organization updated.");
  }

  it("the reported scenario: a name fix after a tab switch does not un-suspend the org", async () => {
    const user = userEvent.setup();
    renderWithIntl(renderOrg(ORG));

    await suspend(user);
    expect(bodies("PATCH")).toEqual([{ status: "suspended" }]);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Back to Settings before the refresh has landed: the remount seeds from
    // the stale props, so the select reads Active again...
    await switchAwayAndBack(user, "Members", "Settings");
    expect(status()).toHaveTextContent("Active");

    // ...but fixing the typo sends the name ONLY, so the suspension stands.
    await user.clear(name());
    await user.type(name(), "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(2));
    expect(bodies("PATCH")[1]).toEqual({ name: "Acme Corp" });
  });

  it("shows the saved values after a tab switch once the refresh lands, even after the remount", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(ORG));

    await suspend(user);
    await switchAwayAndBack(user, "Members", "Settings");
    rerender(renderOrg({ ...ORG, status: "suspended" }));

    await waitFor(() => expect(status()).toHaveTextContent("Suspended"));
    // The refreshed props are the baseline now: nothing is pending.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Organization updated.");
    expect(bodies("PATCH")).toHaveLength(1);
  });

  it("a save moves the baseline at once: saving again with no edit sends nothing", async () => {
    const user = userEvent.setup();
    renderWithIntl(renderOrg(ORG));

    await suspend(user);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(bodies("PATCH")).toHaveLength(1);
    expect(status()).toHaveTextContent("Suspended");
  });

  it("keeps an edit in progress when the refreshed props land", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(ORG));
    await user.click(screen.getByRole("tab", { name: "Settings" }));

    await user.clear(name());
    await user.type(name(), "Acme Corp");
    rerender(renderOrg({ ...ORG, status: "archived" }));

    await waitFor(() => expect(status()).toHaveTextContent("Archived"));
    expect(name()).toHaveValue("Acme Corp");
  });
});

describe("organization Authentication tab (F-39)", () => {
  const DEFAULTS: AuthPolicySettingsJson = {
    requireEmailVerification: true,
    signupApprovalMode: "admin_approval",
    allowedAuthMethods: null,
    autoApproveEmailDomains: null,
  };
  const SAVED: AuthPolicySettingsJson = { ...DEFAULTS, requireEmailVerification: false };
  const ORG: OrganizationDetailJson = {
    id: "o1",
    slug: "acme",
    name: "Acme",
    status: "active",
    isDefault: false,
    memberCount: 3,
    bindingCount: 0,
  };
  const renderOrg = (authSettings: AuthPolicySettingsJson | null) => (
    <OrganizationDetailTabs
      org={ORG}
      canUpdate
      authSettings={authSettings}
      platformAuthDefaults={DEFAULTS}
    />
  );
  const verification = () =>
    screen.getByRole("checkbox", { name: /require email verification/i }) as HTMLButtonElement;

  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
  });

  async function customizeAndSave(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("tab", { name: "Authentication" }));
    await user.click(screen.getByRole("button", { name: /customize/i }));
    await user.click(verification());
    await user.click(screen.getByRole("button", { name: /save policy/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sign-up policy updated.");
  }

  it("refreshes after a save and, once the refresh lands, never shows a live override as inherited", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(null));

    await customizeAndSave(user);
    // The route takes a COMPLETE policy, so the body is the whole policy.
    expect(bodies("PATCH")).toEqual([
      {
        requireEmailVerification: false,
        signupApprovalMode: "admin_approval",
        allowedAuthMethods: null,
        autoApproveEmailDomains: null,
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    await switchAwayAndBack(user, "Members", "Authentication");
    rerender(renderOrg(SAVED));

    expect(await screen.findByRole("button", { name: /save policy/i })).toBeInTheDocument();
    expect(screen.queryByText(/inherits the platform sign-up defaults/i)).not.toBeInTheDocument();
    expect(verification()).not.toBeChecked();
    expect(screen.getByRole("button", { name: /reset to platform defaults/i })).toBeInTheDocument();
  });

  it("the mounted form stays on the saved override when the refresh lands", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(null));

    await customizeAndSave(user);
    rerender(renderOrg(SAVED));

    expect(screen.getByRole("status")).toHaveTextContent("Sign-up policy updated.");
    expect(verification()).not.toBeChecked();
    expect(screen.getByRole("button", { name: /reset to platform defaults/i })).toBeInTheDocument();
  });

  async function resetOverride(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("tab", { name: "Authentication" }));
    await user.click(screen.getByRole("button", { name: /reset to platform defaults/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/override removed/i);
    expect(bodies("PATCH")).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  }

  it("Reset, then a tab switch before the refresh lands: the refresh puts the tab back on the inherit view", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(SAVED));

    await resetOverride(user);
    // The remount seeds from the stale props: the removed override is back.
    await switchAwayAndBack(user, "Members", "Authentication");
    expect(screen.getByRole("button", { name: /reset to platform defaults/i })).toBeInTheDocument();

    rerender(renderOrg(null));
    expect(screen.getByText(/inherits the platform sign-up defaults/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset to platform defaults/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save policy/i })).toBeNull();
  });

  it("Reset, then Customize before the refresh lands: the refresh keeps the editor and the edit", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(renderOrg(SAVED));

    await resetOverride(user);
    await user.click(screen.getByRole("button", { name: /customize/i }));
    expect(verification()).toBeChecked(); // Customize starts from the platform default
    await user.click(verification());

    rerender(renderOrg(null));
    // Still an unsaved Customize: open, edited, and with nothing to reset yet.
    expect(screen.getByRole("button", { name: /save policy/i })).toBeInTheDocument();
    expect(verification()).not.toBeChecked();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset to platform defaults/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /save policy/i }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(1));
    expect(bodies("PATCH")[0]).toMatchObject({ requireEmailVerification: false });
  });
});

describe.each([
  {
    kind: "role",
    url: "/api/administrator/roles/r1",
    render: (name: string, description: string | null) => {
      const role: RoleDetailJson = {
        id: "r1",
        organizationId: "o1",
        key: "support",
        name,
        description,
        permissionKeys: [],
        memberCount: 0,
      };
      return <RoleDetailTabs role={role} canUpdate />;
    },
  },
  {
    kind: "group",
    url: "/api/administrator/groups/g1",
    render: (name: string, description: string | null) => {
      const group: GroupDetailJson = { id: "g1", key: "support", name, description };
      return <GroupDetailTabs group={group} canUpdate canAssign />;
    },
  },
])("$kind Settings tab (F-39)", ({ url, render }) => {
  const name = () => screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement;
  const description = () => screen.getByRole("textbox", { name: /^Description/ });

  beforeEach(() => {
    fetchMock.mockImplementation(async (u: string) => {
      if (String(u) === url) return jsonRes({ ok: true });
      // The role Permissions tab (the default) loads the catalog on mount.
      if (String(u).startsWith("/api/administrator/permissions")) return jsonRes({ items: [] });
      throw new Error(`unrouted fetch: ${String(u)}`);
    });
  });

  it("a description-only save after a rename and a tab switch does not send the old name back", async () => {
    const user = userEvent.setup();
    renderWithIntl(render("Support", null));

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(name(), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(refresh).toHaveBeenCalledTimes(1);

    await switchAwayAndBack(user, "Members", "Settings");
    expect(name()).toHaveValue("Support"); // stale props: the refresh has not landed
    await user.type(description(), "Front line");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(bodies("PATCH")).toHaveLength(2));
    expect(bodies("PATCH")).toEqual([{ name: "Support Team" }, { description: "Front line" }]);
  });

  it("shows the saved name after a tab switch once the refresh lands", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(render("Support", null));

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(name(), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");

    await switchAwayAndBack(user, "Members", "Settings");
    rerender(render("Support Team", null));
    await waitFor(() => expect(name()).toHaveValue("Support Team"));
  });

  it("keeps what the admin types while the save is in flight, and the next save sends it", async () => {
    // The first PATCH is held open; the inputs are not locked meanwhile.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const route = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (u: string, init?: { method?: string }) => {
      if (init?.method === "PATCH" && bodies("PATCH").length === 1) await held;
      return route(u, init);
    });
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(render("Support", null));

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(name(), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(1));
    await user.type(description(), "Front line");
    release();

    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    // Moving the baseline to what was saved did not wipe the in-flight edit...
    expect(name()).toHaveValue("Support Team");
    expect(description()).toHaveValue("Front line");
    // ...nor did the refresh landing with the saved state...
    rerender(render("Support Team", null));
    expect(description()).toHaveValue("Front line");
    // ...so the next save sends it instead of finding nothing to send.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(2));
    expect(bodies("PATCH")).toEqual([{ name: "Support Team" }, { description: "Front line" }]);
  });

  it("a field the last save wrote is not an edit any more: it takes the refreshed value", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(render("Support", null));

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(name(), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");

    // The refresh brings a newer name (another admin renamed it meanwhile).
    rerender(render("Support Crew", null));
    await waitFor(() => expect(name()).toHaveValue("Support Crew"));
    await user.type(description(), "Front line");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(2));
    // The name this form saved earlier is not written back over the newer one.
    expect(bodies("PATCH")[1]).toEqual({ description: "Front line" });
  });

  it("a failed save's error and its edit stay when an earlier save's refresh lands", async () => {
    const route = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (u: string, init?: { method?: string }) =>
      init?.method === "PATCH" && bodies("PATCH").length === 2
        ? jsonRes({ error: "internal" }, 500)
        : route(u, init),
    );
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(render("Support", null));

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(name(), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    await user.type(description(), "Front line");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save changes.");

    // The first save's refresh lands after the second save failed.
    rerender(render("Support Team", null));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save changes.");
    expect(description()).toHaveValue("Front line");
  });
});

describe("role Permissions tab (F-39)", () => {
  const CATALOG = ["admin.users.ban", "admin.users.read", "admin.users.update"].map((key, i) => ({
    id: `p${i}`,
    key,
    description: null,
    used_by_role_count: 0,
  }));
  const role = (permissionKeys: string[]): RoleDetailJson => ({
    id: "r1",
    organizationId: "o1",
    key: "support",
    name: "Support",
    description: null,
    permissionKeys,
    memberCount: 0,
  });
  const INITIAL = ["admin.users.ban", "admin.users.read"];
  const SAVED = ["admin.users.read", "admin.users.update"];

  /** An in-memory role-permissions collection: writes change what GET returns. */
  function serve(): Set<string> {
    const server = new Set(INITIAL);
    fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
      const url = String(u);
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/administrator/permissions")) return jsonRes({ items: CATALOG });
      if (url === "/api/administrator/roles/r1/permissions") {
        const ids = method === "GET" ? [] : (JSON.parse(init!.body!) as { ids: string[] }).ids;
        if (method === "POST") ids.forEach((id) => server.add(id));
        if (method === "DELETE") ids.forEach((id) => server.delete(id));
        return jsonRes(method === "GET" ? { permissions: [...server].sort() } : { ok: true });
      }
      throw new Error(`unrouted fetch: ${method} ${url}`);
    });
    return server;
  }

  const lists = () => {
    const [available, assigned] = screen.getAllByRole("listbox") as HTMLSelectElement[];
    return { available: available!, assigned: assigned! };
  };
  const values = (list: HTMLSelectElement) =>
    Array.from(list.querySelectorAll("option"))
      .map((o) => o.value)
      .filter(Boolean)
      .sort();
  const ready = () =>
    waitFor(() => expect(values(lists().available)).toContain("admin.users.update"));

  async function stageAndSave(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await ready();
    await user.selectOptions(lists().available, "admin.users.update");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.selectOptions(lists().assigned, "admin.users.ban");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Permissions updated.");
  }

  it("refreshes after a save, and a tab switch shows the saved set once the refresh lands", async () => {
    const server = serve();
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(<RoleDetailTabs role={role(INITIAL)} canUpdate />);

    await stageAndSave(user);
    expect([...server].sort()).toEqual(SAVED);
    expect(refresh).toHaveBeenCalledTimes(1);

    await switchAwayAndBack(user, "Members", "Permissions");
    await ready();
    rerender(<RoleDetailTabs role={role(SAVED)} canUpdate />);

    await waitFor(() => expect(values(lists().assigned)).toEqual(SAVED));
    expect(values(lists().available)).toEqual(["admin.users.ban"]);
    // The saved set is the baseline too, so nothing is pending.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("does not overwrite unsaved moves when fresh props arrive", async () => {
    serve();
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(<RoleDetailTabs role={role(INITIAL)} canUpdate />);
    await ready();

    await user.selectOptions(lists().assigned, "admin.users.read");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    rerender(<RoleDetailTabs role={role(SAVED)} canUpdate />);

    expect(values(lists().assigned)).toEqual(["admin.users.ban"]);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

describe("pickChangedFields (F-39)", () => {
  it("keeps only the keys whose value differs, comparing arrays by content", () => {
    expect(
      pickChangedFields(
        { name: "Acme", status: "suspended", methods: ["email"], domains: null },
        { name: "Acme", status: "active", methods: ["email"], domains: null },
      ),
    ).toEqual({ status: "suspended" });
    expect(pickChangedFields({ methods: ["email", "google"] }, { methods: ["email"] })).toEqual({
      methods: ["email", "google"],
    });
    expect(pickChangedFields({ a: 1 }, { a: 1 })).toEqual({});
  });
});
