// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the Administrator Groups UI (ADR-0002).
 *
 * The group routes are covered at the HTTP layer by
 * tests/integration/groups.test.ts; these pin the client behaviour of the
 * grid, the create/settings forms, the dual-list roles editor, the members
 * grid, and the detail tab container — the dirty-diff save flow and the
 * error branches in particular.
 */
const push = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace, prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/groups",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/i18n/locale-link", () => ({
  LocaleLink: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} className={className}>
      {children}
    </a>
  ),
}));

const confirmMock = vi.fn();
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: confirmMock, alert: vi.fn(), prompt: vi.fn() }),
}));

import { AdministratorGroupsGrid } from "@/app/[locale]/(secure)/app/administrator/groups/_groups-grid";
import { NewGroupForm } from "@/app/[locale]/(secure)/app/administrator/groups/new/_new-group-form";
import { GroupSettingsForm } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-settings-form";
import { GroupRolesEditor } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor";
import { GroupMembersGrid } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid";
import { UserPicker } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_user-picker";
import { GroupDetailTabs } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-detail-tabs";

const fetchMock = vi.fn();

function jsonOk(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  replace.mockReset();
  confirmMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdministratorGroupsGrid", () => {
  const row = {
    id: "g1",
    organization_id: "o1",
    key: "engineering",
    name: "Engineering",
    description: null,
    role_count: 2,
    member_count: 5,
    created_at: "2026-01-02T00:00:00Z",
  };

  it("renders fetched group rows with a key link and counts", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [row], total: 1 }));
    renderWithIntl(<AdministratorGroupsGrid locale="en" canDelete={false} />);

    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "engineering" });
    expect(link).toHaveAttribute("href", "/app/administrator/groups/g1");
    // No delete column when the caller lacks admin.groups.delete.
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("deletes a row after the confirm dialog resolves true", async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") return Promise.resolve(jsonOk({ ok: true }));
      return Promise.resolve(jsonOk({ items: [row], total: 1 }));
    });
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();

    renderWithIntl(<AdministratorGroupsGrid locale="en" canDelete />);
    await screen.findByText("Engineering");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups/g1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("does not issue a DELETE when the confirm dialog is dismissed", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [row], total: 1 }));
    confirmMock.mockResolvedValue(false);
    const user = userEvent.setup();

    renderWithIntl(<AdministratorGroupsGrid locale="en" canDelete />);
    await screen.findByText("Engineering");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });
});

describe("NewGroupForm", () => {
  it("blocks submit and shows a validation error for an empty key", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewGroupForm locale="en" showOrgPicker={false} />);

    await user.click(screen.getByRole("button", { name: "Create group" }));

    // Field-level validation marks the control invalid (red border) instead of
    // the old generic banner, and blocks the request.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Key" })).toHaveAttribute("aria-invalid", "true"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts and navigates to the created group on 201", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "g9" }, 201));
    const user = userEvent.setup();
    renderWithIntl(<NewGroupForm locale="en" showOrgPicker={false} />);

    await user.type(screen.getByRole("textbox", { name: "Key" }), "engineering");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/app/administrator/groups/g9"));
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces a key-taken error on 409", async () => {
    fetchMock.mockResolvedValue(jsonOk({ error: "key_taken" }, 409));
    const user = userEvent.setup();
    renderWithIntl(<NewGroupForm locale="en" showOrgPicker={false} />);

    await user.type(screen.getByRole("textbox", { name: "Key" }), "engineering");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByText("That key is already in use.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates back to the list on cancel", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewGroupForm locale="en" showOrgPicker={false} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(push).toHaveBeenCalledWith("/en/app/administrator/groups");
  });
});

describe("NewGroupForm (SUPERADMIN org picker)", () => {
  // The form now validates organizationId against the shared schema's UUID rule.
  const ORG = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" };

  function routeOrgsAndGroups() {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/administrator/organizations")) {
        return Promise.resolve(jsonOk({ items: [ORG], total: 1 }));
      }
      return Promise.resolve(jsonOk({ id: "g9" }, 201));
    });
  }

  it("blocks submit until an organization is chosen", async () => {
    routeOrgsAndGroups();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<NewGroupForm locale="en" showOrgPicker />);

    // The picker renders for a SUPERADMIN; org options load from the endpoint.
    await waitFor(() => expect(container.querySelector("#group-organization")).not.toBeDisabled());
    await user.type(screen.getByRole("textbox", { name: "Key" }), "engineering");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByText("Select an organization for this group.")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("sends the chosen organizationId on submit", async () => {
    routeOrgsAndGroups();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<NewGroupForm locale="en" showOrgPicker />);

    const picker = container.querySelector("#group-organization")!;
    await waitFor(() => expect(picker).not.toBeDisabled());
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /Acme/ }));
    await user.type(screen.getByRole("textbox", { name: "Key" }), "engineering");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
    )!;
    expect(JSON.parse((postCall[1] as { body: string }).body)).toMatchObject({
      organizationId: ORG.id,
    });
  });
});

describe("GroupSettingsForm", () => {
  it("PATCHes and shows the saved confirmation", async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true }));
    const user = userEvent.setup();
    renderWithIntl(
      <GroupSettingsForm
        groupId="g1"
        initialKey="engineering"
        initialName="Engineering"
        initialDescription={null}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups/g1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("shows an invalid-body error on 400", async () => {
    fetchMock.mockResolvedValue(jsonOk({ error: "invalid_body" }, 400));
    const user = userEvent.setup();
    renderWithIntl(
      <GroupSettingsForm
        groupId="g1"
        initialKey="engineering"
        initialName="Engineering"
        initialDescription="Builds things"
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The submitted data is invalid.");
  });
});

describe("GroupRolesEditor", () => {
  const VIEWER = {
    id: "r1",
    key: "app.viewer",
    name: "Viewer",
    organization_id: "o1",
    organization_name: "Acme",
  };
  const EDITOR = {
    id: "r2",
    key: "app.editor",
    name: "Editor",
    organization_id: "o1",
    organization_name: "Acme",
  };
  const CATALOG = { items: [VIEWER, EDITOR] };

  function routeRoles(opts: { assignedAfterPost?: typeof CATALOG.items } = {}) {
    let posted = false;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const u = String(url);
      // Group detail → the editor reads the group's org id from here.
      if (/\/api\/administrator\/groups\/g1$/.test(u)) {
        return Promise.resolve(jsonOk({ group: { id: "g1", organization_id: "o1" } }));
      }
      if (u.includes("/api/administrator/roles")) return Promise.resolve(jsonOk(CATALOG));
      if (u.includes("/roles") && init?.method === "POST") {
        posted = true;
        return Promise.resolve(jsonOk({ ok: true }));
      }
      if (u.includes("/roles") && init?.method === "DELETE") {
        return Promise.resolve(jsonOk({ ok: true }));
      }
      // GET the group's assigned roles (initial + post-save refresh).
      return Promise.resolve(jsonOk({ roles: posted ? (opts.assignedAfterPost ?? []) : [] }));
    });
  }

  it("loads both columns and saves the diff as a POST", async () => {
    routeRoles({ assignedAfterPost: [VIEWER] });
    const user = userEvent.setup();
    renderWithIntl(<GroupRolesEditor groupId="g1" canAssign />);

    // Available column populated from the catalog once the fetches resolve.
    expect(await screen.findByText(/Available/)).toBeInTheDocument();
    // The catalog fetch is scoped to the group's org, using the bracket
    // filter syntax parseListQuery actually parses (a bare `organization=`
    // param would be silently dropped, returning an unfiltered list).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/administrator/roles?filter[organization]=o1"),
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    // Each option is labelled `key — Organization` so same-key roles stay distinct.
    expect(await screen.findByText("app.viewer — Acme")).toBeInTheDocument();
    const available = screen.getAllByRole("listbox")[0]!;
    await user.selectOptions(available, "r1");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups/g1/roles",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Roles updated.");
  });

  it("shows an error when the initial load fails", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<GroupRolesEditor groupId="g1" canAssign />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("disables the controls when canAssign is false", async () => {
    routeRoles();
    renderWithIntl(<GroupRolesEditor groupId="g1" canAssign={false} />);

    await screen.findByText(/Available/);
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });
});

describe("GroupMembersGrid", () => {
  it("renders members with an email link into the user detail", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        items: [
          {
            app_user_id: "u1",
            primary_email: "ada@example.com",
            display_name: "Ada",
            status: "active",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
      }),
    );
    renderWithIntl(<GroupMembersGrid groupId="g1" />);

    const link = await screen.findByRole("link", { name: "ada@example.com" });
    expect(link).toHaveAttribute("href", "/app/administrator/users/u1");
  });
});

describe("GroupDetailTabs", () => {
  it("switches between the roles, members, and settings tabs", async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (/\/api\/administrator\/groups\/g1$/.test(u)) {
        return Promise.resolve(jsonOk({ group: { id: "g1", organization_id: "o1" } }));
      }
      if (u.includes("/api/administrator/roles")) {
        return Promise.resolve(
          jsonOk({
            items: [
              {
                id: "r1",
                key: "app.viewer",
                name: "Viewer",
                organization_id: "o1",
                organization_name: "Acme",
              },
            ],
          }),
        );
      }
      if (u.includes("/members")) {
        return Promise.resolve(
          jsonOk({
            items: [
              {
                app_user_id: "u1",
                primary_email: "ada@example.com",
                display_name: "Ada",
                status: "active",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            total: 1,
          }),
        );
      }
      return Promise.resolve(jsonOk({ roles: [] }));
    });
    const user = userEvent.setup();
    renderWithIntl(
      <GroupDetailTabs
        group={{ id: "g1", key: "engineering", name: "Engineering", description: null }}
        canUpdate
        canAssign
      />,
    );

    // Roles tab is the default.
    expect(await screen.findByText(/Available/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Members" }));
    expect(await screen.findByRole("link", { name: "ada@example.com" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const keyField = (await screen.findByDisplayValue("engineering")) as HTMLInputElement;
    expect(keyField).toHaveAttribute("readonly");
  });
});

describe("GroupMembersGrid (member management)", () => {
  const member = {
    app_user_id: "u1",
    primary_email: "ada@example.com",
    display_name: "Ada",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
  };
  const candidate = { id: "u2", primary_email: "bob@example.com", display_name: "Bob" };

  function routeMembers(addedCount = 1) {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === "POST") return Promise.resolve(jsonOk({ ok: true, added: addedCount }));
      if (init?.method === "DELETE") return Promise.resolve(jsonOk({ ok: true, removed: 1 }));
      // User picker search — must be checked before the /members list route.
      if (u.includes("/api/administrator/users"))
        return Promise.resolve(jsonOk({ items: [candidate] }));
      if (u.includes("/members")) return Promise.resolve(jsonOk({ items: [member], total: 1 }));
      return Promise.resolve(jsonOk({ items: [], total: 0 }));
    });
  }

  function postBody() {
    const call = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
    );
    return { url: call?.[0], body: JSON.parse((call?.[1] as { body: string }).body) };
  }

  it("shows no add/remove controls without admin.groups.assign", async () => {
    routeMembers();
    renderWithIntl(<GroupMembersGrid groupId="g1" canAssign={false} />);
    await screen.findByRole("link", { name: "ada@example.com" });
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("adds a member, posting { appUserIds: [chosen] }", async () => {
    routeMembers(1);
    const user = userEvent.setup();
    renderWithIntl(<GroupMembersGrid groupId="g1" canAssign />);

    await user.click(await screen.findByRole("button", { name: "Add member" }));
    await screen.findByText("Add a member"); // dialog open
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /bob@example.com/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postBody().url).toContain("/api/administrator/groups/g1/members"));
    expect(postBody().body).toEqual({ appUserIds: ["u2"] });
  });

  it("surfaces the not-eligible message when the server adds nobody", async () => {
    routeMembers(0); // server dropped the pick (not an active org member)
    const user = userEvent.setup();
    renderWithIntl(<GroupMembersGrid groupId="g1" canAssign />);

    await user.click(await screen.findByRole("button", { name: "Add member" }));
    await screen.findByText("Add a member");
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /bob@example.com/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/isn't an active member/)).toBeInTheDocument();
  });

  it("removes a member via DELETE after the confirm resolves true", async () => {
    routeMembers();
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();
    renderWithIntl(<GroupMembersGrid groupId="g1" canAssign />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
      );
      expect(del?.[0]).toContain("/api/administrator/groups/g1/members");
      expect(JSON.parse((del?.[1] as { body: string }).body)).toEqual({ appUserIds: ["u1"] });
    });
  });
});

describe("UserPicker", () => {
  const ADA = { id: "u1", primary_email: "ada@example.com", display_name: "Ada" };

  it("searches users server-side and reports the chosen user", async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(String(url)).toContain("/api/administrator/users");
      return Promise.resolve(jsonOk({ items: [ADA] }));
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<UserPicker value={null} onChange={onChange} />);

    const trigger = container.querySelector("#user-picker")!;
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /ada@example.com/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
  });

  it("surfaces an error when the initial user load fails", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<UserPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load users.");
  });
});
