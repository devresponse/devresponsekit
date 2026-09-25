// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-41: the Administrator's pickers and catalog editors read ONE page of an
 * admin list (`pageSize=200`, or 100) and ignored `total`. Past 200
 * organizations a superadmin could not pick a later org in New role / New
 * group (a group requires one), and roles, groups and permission keys past the
 * 200th could not be assigned. Nothing on screen said a row was missing.
 *
 * Pinned here, against fake list endpoints that answer like `parseListQuery`
 * (`q` search, `page`, `pageSize` clamped to 200 and echoed, `total`):
 *   - the pickers search the SERVER (`q=`), reach a row past position 200,
 *     drop a stale response, and say "Showing N of M" while more match;
 *   - the catalog editors read every page, show a row past position 200, keep
 *     an assigned key the catalog does not hold when it is moved out, and say
 *     "Showing N of M" when the catalog could not be read in full.
 */
const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator",
  useSearchParams: () => new URLSearchParams(""),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: () => Promise.resolve(true) }),
}));

import { OrganizationPicker } from "@/app/[locale]/(secure)/app/administrator/_components/organization-picker";
import { NewGroupForm } from "@/app/[locale]/(secure)/app/administrator/groups/new/_new-group-form";
import {
  RolePicker,
  type RoleOption,
} from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_role-picker";
import { GroupPicker } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_group-picker";
import { RolePermissionsEditor } from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-permissions-editor";
import { GroupRolesEditor } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor";
import { OrganizationInvitationsPanel } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel";
import { RolesUsingPermissionPanel } from "@/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const fetchMock = vi.fn();

type Row = Record<string, unknown> & { id: string };

interface ListOpts {
  /** The columns `q` matches (case-insensitive contains). */
  searchable: string[];
  /** Added to the envelope's `total` (a count the pages cannot reach). */
  totalSkew?: number;
}

/** Answers a list request the way `parseListQuery` + a list route do. */
function listAnswer(rows: Row[], url: URL, opts: ListOpts) {
  const q = url.searchParams.get("q")?.toLowerCase() ?? "";
  const matched = q
    ? rows.filter((r) =>
        opts.searchable.some((c) =>
          String(r[c] ?? "")
            .toLowerCase()
            .includes(q),
        ),
      )
    : rows;
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Math.min(Number(url.searchParams.get("pageSize") ?? "25"), 200);
  const items = matched.slice((page - 1) * pageSize, page * pageSize);
  return { items, page, pageSize, total: matched.length + (opts.totalSkew ?? 0) };
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function urlOf(input: unknown): URL {
  return new URL(String(input), "http://test.local");
}

/** The GET URLs sent to `path`, parsed. */
function requestsTo(path: string): URL[] {
  return fetchMock.mock.calls.map(([input]) => urlOf(input)).filter((u) => u.pathname === path);
}

const pad = (n: number) => String(n).padStart(3, "0");

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/* -------------------------------------------------------------------------- */
/*  Pickers: server search                                                    */
/* -------------------------------------------------------------------------- */

// 250 orgs sorted by slug; `zenith` sorts LAST, far past the old 200-row page.
const ORGS: Row[] = [
  ...Array.from({ length: 249 }, (_, i) => ({
    id: `00000000-0000-4000-8000-000000000${pad(i + 1)}`,
    slug: `org-${pad(i + 1)}`,
    name: `Org ${pad(i + 1)}`,
  })),
  { id: "99999999-9999-4999-8999-999999999999", slug: "zenith", name: "Zenith" },
];
const ZENITH = ORGS[249]!;

/** Serves ORGS; `extra` answers anything else first (`undefined` to pass). */
function serveOrgs(extra?: (url: URL, init?: { method?: string }) => unknown) {
  fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
    const url = urlOf(input);
    const other = extra?.(url, init);
    if (other !== undefined) return other;
    if (url.pathname === "/api/administrator/organizations") {
      return json(listAnswer(ORGS, url, { searchable: ["slug", "name"] }));
    }
    throw new Error(`unrouted fetch: ${url.pathname}`);
  });
}

/** Opens a combobox once its first answer has loaded (the trigger un-disables). */
async function openPicker(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  await waitFor(() => expect(trigger).not.toBeDisabled());
  await user.click(trigger);
}

function PickerHarness({ includeGlobal = false }: { includeGlobal?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <OrganizationPicker value={value} onChange={setValue} includeGlobal={includeGlobal} />
      <output data-testid="chosen">{value ?? "none"}</output>
    </>
  );
}

describe("OrganizationPicker server search (F-41)", () => {
  it("lists the first answer and says how many more organizations exist", async () => {
    serveOrgs();
    const user = userEvent.setup();
    renderWithIntl(<PickerHarness />);

    await openPicker(user, screen.getByRole("combobox", { name: "Organization" }));

    expect(await screen.findAllByRole("option")).toHaveLength(50);
    expect(screen.getByText("Showing 50 of 250. Type to narrow the list.")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Zenith/ })).toBeNull();
    const first = requestsTo("/api/administrator/organizations")[0]!;
    expect(first.searchParams.get("pageSize")).toBe("50");
    expect(first.searchParams.has("q")).toBe(false);
  });

  it("typing `zenith` asks the server (q=zenith) and selects the org past position 200", async () => {
    serveOrgs();
    const user = userEvent.setup();
    renderWithIntl(<PickerHarness />);
    const trigger = screen.getByRole("combobox", { name: "Organization" });

    await openPicker(user, trigger);
    await user.type(screen.getByPlaceholderText("Search organizations…"), "zenith");

    await user.click(await screen.findByRole("option", { name: "Zenith (zenith)" }));
    expect(requestsTo("/api/administrator/organizations").at(-1)!.searchParams.get("q")).toBe(
      "zenith",
    );
    expect(screen.getByTestId("chosen")).toHaveTextContent(ZENITH.id);
    // The trigger names the choice even though no answer on screen holds it.
    expect(trigger).toHaveTextContent("Zenith (zenith)");
  });

  it("drops a stale answer: a slow reply to `z` never replaces the reply to `zenith`", async () => {
    let releaseZ: () => void = () => {};
    const zHeld = new Promise<void>((resolve) => (releaseZ = resolve));
    // The reply to the first keystroke is held until the last one's has
    // rendered, and carries a row no later answer has, so a leak shows.
    serveOrgs((url) => {
      if (
        url.pathname === "/api/administrator/organizations" &&
        url.searchParams.get("q") === "z"
      ) {
        return zHeld.then(() =>
          json({
            items: [{ id: "stale", slug: "zulu-stale", name: "Stale Zulu" }],
            page: 1,
            pageSize: 50,
            total: 1,
          }),
        );
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderWithIntl(<PickerHarness />);

    await openPicker(user, screen.getByRole("combobox", { name: "Organization" }));
    await user.type(screen.getByPlaceholderText("Search organizations…"), "zenith");
    expect(await screen.findByRole("option", { name: "Zenith (zenith)" })).toBeInTheDocument();

    releaseZ();
    await zHeld;
    // Give the late reply every chance to commit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("option", { name: /Stale Zulu/ })).toBeNull();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Zenith (zenith)"]);
  });

  it("offers Global only while the search is empty or matches it", async () => {
    serveOrgs();
    const user = userEvent.setup();
    renderWithIntl(<PickerHarness includeGlobal />);

    await openPicker(user, screen.getByRole("combobox", { name: "Organization" }));
    expect(await screen.findByRole("option", { name: /Global/ })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search organizations…"), "zenith");
    await screen.findByRole("option", { name: "Zenith (zenith)" });
    expect(screen.queryByRole("option", { name: /Global/ })).toBeNull();
  });

  it("a superadmin creates a group in an org past position 200 (the form requires one)", async () => {
    serveOrgs((url, init) =>
      url.pathname === "/api/administrator/groups" && init?.method === "POST"
        ? json({ id: "g9" }, 201)
        : undefined,
    );
    const user = userEvent.setup();
    const { container } = renderWithIntl(<NewGroupForm locale="en" showOrgPicker />);

    await openPicker(user, container.querySelector<HTMLElement>("#group-organization")!);
    await user.type(screen.getByPlaceholderText("Search organizations…"), "zenith");
    await user.click(await screen.findByRole("option", { name: "Zenith (zenith)" }));
    await user.type(screen.getByRole("textbox", { name: /Key/ }), "engineering");
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/groups",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    )!;
    expect(JSON.parse((post[1] as { body: string }).body)).toMatchObject({
      organizationId: ZENITH.id,
    });
  });
});

// 300 org-scoped roles plus a global one. `support` sorts after 260 others.
const ROLES: Row[] = [
  {
    id: "global-role",
    key: "superuser",
    name: "Superuser",
    organization_id: null,
    organization_name: null,
  },
  ...Array.from({ length: 260 }, (_, i) => ({
    id: `role-${pad(i + 1)}`,
    key: "admin",
    name: "Admin",
    organization_id: `org-${pad(i + 1)}`,
    organization_name: `Org ${pad(i + 1)}`,
  })),
  {
    id: "role-support",
    key: "support",
    name: "Support",
    organization_id: "org-zen",
    organization_name: "Zenith",
  },
];

function serveRoles() {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = urlOf(input);
    if (url.pathname === "/api/administrator/roles") {
      // `filter[scope]=org` drops global roles, as the route does.
      const rows =
        url.searchParams.get("filter[scope]") === "org"
          ? ROLES.filter((r) => r.organization_id !== null)
          : ROLES;
      return json(listAnswer(rows, url, { searchable: ["key", "name", "organization_name"] }));
    }
    throw new Error(`unrouted fetch: ${url.pathname}`);
  });
}

describe("RolePicker server search (F-41)", () => {
  it("asks for org-scoped roles only and finds one past position 200 by key or org name", async () => {
    serveRoles();
    const onChange = vi.fn<(next: RoleOption | null) => void>();
    const user = userEvent.setup();
    renderWithIntl(<RolePicker value={null} onChange={onChange} />);

    await openPicker(user, screen.getByRole("combobox", { name: "Role" }));
    expect(
      await screen.findByText("Showing 50 of 261. Type to narrow the list."),
    ).toBeInTheDocument();
    expect(requestsTo("/api/administrator/roles")[0]!.searchParams.get("filter[scope]")).toBe(
      "org",
    );

    await user.type(screen.getByPlaceholderText("Search roles…"), "zenith");
    await user.click(await screen.findByRole("option", { name: /Support/ }));

    expect(requestsTo("/api/administrator/roles").at(-1)!.searchParams.get("q")).toBe("zenith");
    expect(onChange).toHaveBeenCalledWith({
      id: "role-support",
      organization_id: "org-zen",
      organization_name: "Zenith",
      key: "support",
      name: "Support",
    });
  });
});

describe("GroupPicker searches the target user's orgs (F-41)", () => {
  const USER = "u-target";
  const MEMBERSHIPS_PATH = `/api/administrator/users/${USER}/memberships`;

  // 60 orgs, each holding an `engineering` group named "Engineering" (the
  // same text in every org), and org 001 also holding 230 `team-*` groups.
  const orgId = (n: number) => `org-${pad(n)}`;
  const orgName = (n: number) => `Org ${pad(n)}`;
  const GROUPS: Array<Row & { organization_id: string; org_name: string }> = [
    ...Array.from({ length: 60 }, (_, i) => ({
      id: `eng-${pad(i + 1)}`,
      organization_id: orgId(i + 1),
      org_name: orgName(i + 1),
      key: "engineering",
      name: "Engineering",
    })),
    ...Array.from({ length: 230 }, (_, i) => ({
      id: `group-${pad(i + 1)}`,
      organization_id: orgId(1),
      org_name: orgName(1),
      key: `team-${pad(i + 1)}`,
      name: `Team ${pad(i + 1)}`,
    })),
  ];

  /**
   * Serves the user's memberships in `orgs` and a groups endpoint that honours
   * repeated `filter[organization]` and matches `q` on key, name and org name,
   * as the route does. The org name is matched but not returned, as the route.
   */
  function serveGroups(orgs: number[]) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.pathname === MEMBERSHIPS_PATH) {
        const rows = orgs.map((n) => ({
          id: `m-${pad(n)}`,
          organization_id: orgId(n),
          organization_name: orgName(n),
        }));
        return json(listAnswer(rows, url, { searchable: [] }));
      }
      if (url.pathname === "/api/administrator/groups") {
        const scope = url.searchParams.getAll("filter[organization]");
        const rows = scope.length
          ? GROUPS.filter((g) => scope.includes(g.organization_id))
          : GROUPS;
        const answer = listAnswer(rows, url, { searchable: ["key", "name", "org_name"] });
        return json({ ...answer, items: answer.items.map(({ org_name: _, ...g }) => g) });
      }
      throw new Error(`unrouted fetch: ${url.pathname}`);
    });
  }

  it("a user in one of 60 orgs that each hold `engineering` is offered that org's, not 50 of 60", async () => {
    serveGroups([57]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithIntl(<GroupPicker userId={USER} value={null} onChange={onChange} />);

    await openPicker(user, screen.getByRole("combobox", { name: "Group" }));
    await user.type(screen.getByPlaceholderText("Search groups…"), "engineering");

    await waitFor(() =>
      expect(requestsTo("/api/administrator/groups").at(-1)!.searchParams.get("q")).toBe(
        "engineering",
      ),
    );
    await user.click(await screen.findByRole("option", { name: /Engineering/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eng-057", organization_id: orgId(57) }),
    );
    expect(screen.queryByText(/^Showing /)).toBeNull();
    // Every groups request named the user's org: none spanned every org.
    const scopes = requestsTo("/api/administrator/groups").map((u) =>
      u.searchParams.getAll("filter[organization]"),
    );
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((s) => s.length === 1 && s[0] === orgId(57))).toBe(true);
  });

  it("names each option's org when the user is in several, and finds one by the org's name", async () => {
    serveGroups([57, 58]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithIntl(<GroupPicker userId={USER} value={null} onChange={onChange} />);

    await openPicker(user, screen.getByRole("combobox", { name: "Group" }));
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent?.replace(/\s+/g, " ")),
    ).toEqual(["Engineering · engineering · Org 057", "Engineering · engineering · Org 058"]);
    expect(
      requestsTo("/api/administrator/groups")[0]!.searchParams.getAll("filter[organization]"),
    ).toEqual([orgId(57), orgId(58)]);

    await user.type(screen.getByPlaceholderText("Search groups…"), "Org 058");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await user.click(screen.getByRole("option", { name: /Org 058/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "eng-058" }));
  });

  it("reaches a group past position 200 and lists joined groups as unavailable, not hidden", async () => {
    serveGroups([1]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    // The user already belongs to every group of the first answer.
    const joined = GROUPS.filter((g) => g.organization_id === orgId(1))
      .slice(0, 50)
      .map((g) => g.id);
    renderWithIntl(
      <GroupPicker userId={USER} value={null} onChange={onChange} excludeIds={joined} />,
    );

    await openPicker(user, screen.getByRole("combobox", { name: "Group" }));
    const first = await screen.findAllByRole("option");
    // The answer is listed as it came, so the notice's count matches the list
    // on screen instead of "No groups found" over "Showing 50 of 231".
    expect(first).toHaveLength(50);
    expect(first.every((o) => o.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(first[0]).toHaveTextContent("Already a member");
    expect(screen.queryByText("No groups found.")).toBeNull();
    expect(screen.getByText("Showing 50 of 231. Type to narrow the list.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search groups…"), "team-2");
    await user.click(await screen.findByRole("option", { name: /Team 230/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "group-230" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a user with no organization in scope is offered nothing, and no group list is asked for", async () => {
    serveGroups([]);
    const user = userEvent.setup();
    renderWithIntl(<GroupPicker userId={USER} value={null} onChange={vi.fn()} />);

    await openPicker(user, screen.getByRole("combobox", { name: "Group" }));
    expect(await screen.findByText("No groups found.")).toBeInTheDocument();
    expect(requestsTo(MEMBERSHIPS_PATH)).toHaveLength(1);
    expect(requestsTo("/api/administrator/groups")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Catalog editors: every page                                               */
/* -------------------------------------------------------------------------- */

function lists(): { available: HTMLSelectElement; assigned: HTMLSelectElement } {
  const [available, assigned] = screen.getAllByRole("listbox") as HTMLSelectElement[];
  return { available: available!, assigned: assigned! };
}

function values(list: HTMLSelectElement): string[] {
  return Array.from(list.querySelectorAll("option"))
    .map((o) => o.value)
    .filter(Boolean);
}

const PERMISSIONS: Row[] = Array.from({ length: 450 }, (_, i) => ({
  id: `p${pad(i + 1)}`,
  key: `perm.${pad(i + 1)}`,
  description: null,
  used_by_role_count: 0,
}));

function servePermissionsEditor(assigned: Set<string>, opts: { totalSkew?: number } = {}) {
  fetchMock.mockImplementation(
    async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/administrator/permissions") {
        return json(listAnswer(PERMISSIONS, url, { searchable: ["key"], ...opts }));
      }
      if (url.pathname === "/api/administrator/roles/r1/permissions") {
        const ids = (JSON.parse(init?.body ?? "{}") as { ids?: string[] }).ids ?? [];
        if (method === "POST") for (const id of ids) assigned.add(id);
        if (method === "DELETE") for (const id of ids) assigned.delete(id);
        return json(method === "GET" ? { permissions: [...assigned].sort() } : { ok: true });
      }
      throw new Error(`unrouted fetch: ${method} ${url.pathname}`);
    },
  );
}

describe("RolePermissionsEditor catalog (F-41)", () => {
  it("reads every catalog page and assigns a key past position 200", async () => {
    const server = new Set(["perm.001"]);
    servePermissionsEditor(server);
    const user = userEvent.setup();
    renderWithIntl(<RolePermissionsEditor roleId="r1" initialAssigned={["perm.001"]} canUpdate />);

    await waitFor(() => expect(values(lists().available)).toContain("perm.450"));
    expect(values(lists().available)).toHaveLength(449);
    expect(
      requestsTo("/api/administrator/permissions").map((u) => u.searchParams.get("page")),
    ).toEqual(["1", "2", "3"]);
    expect(screen.queryByText(/Showing \d+ of/)).toBeNull();

    await user.selectOptions(lists().available, "perm.450");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Permissions updated.");
    expect(server).toEqual(new Set(["perm.001", "perm.450"]));
  });

  it("keeps an assigned key the catalog does not hold when it is moved out, and back", async () => {
    servePermissionsEditor(new Set(["perm.001", "legacy.outside"]));
    const user = userEvent.setup();
    renderWithIntl(
      <RolePermissionsEditor
        roleId="r1"
        initialAssigned={["perm.001", "legacy.outside"]}
        canUpdate
      />,
    );
    await waitFor(() => expect(values(lists().available)).toContain("perm.450"));

    await user.selectOptions(lists().assigned, "legacy.outside");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    // It used to vanish from BOTH columns here.
    expect(values(lists().assigned)).toEqual(["perm.001"]);
    expect(values(lists().available)).toContain("legacy.outside");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await user.selectOptions(lists().available, "legacy.outside");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(values(lists().assigned)).toEqual(["legacy.outside", "perm.001"]);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("keeps it listed after its removal is saved", async () => {
    const server = new Set(["perm.001", "legacy.outside"]);
    servePermissionsEditor(server);
    const user = userEvent.setup();
    renderWithIntl(
      <RolePermissionsEditor
        roleId="r1"
        initialAssigned={["perm.001", "legacy.outside"]}
        canUpdate
      />,
    );
    await waitFor(() => expect(values(lists().available)).toContain("perm.450"));

    await user.selectOptions(lists().assigned, "legacy.outside");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Permissions updated.");
    expect(server).toEqual(new Set(["perm.001"]));
    expect(values(lists().available)).toContain("legacy.outside");
  });

  it("says so when the catalog could not be read in full", async () => {
    servePermissionsEditor(new Set(), { totalSkew: 5 });
    renderWithIntl(<RolePermissionsEditor roleId="r1" initialAssigned={[]} canUpdate />);

    expect(
      await screen.findByText(
        "Showing 450 of 455. The rest could not be loaded and are not listed.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error, not an endless skeleton, when a catalog page fails", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.searchParams.get("page") === "2") return json({}, 500);
      return json(listAnswer(PERMISSIONS, url, { searchable: ["key"] }));
    });
    renderWithIntl(<RolePermissionsEditor roleId="r1" initialAssigned={[]} canUpdate />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
  });
});

describe("GroupRolesEditor catalog (F-41)", () => {
  const ORG_ROLES: Row[] = Array.from({ length: 250 }, (_, i) => ({
    id: `r${pad(i + 1)}`,
    key: `app.role${pad(i + 1)}`,
    name: `Role ${pad(i + 1)}`,
    organization_id: "o1",
    organization_name: "Acme",
  }));

  function serveGroup(assigned: Array<{ id: string; key: string; name: string }>) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.pathname === "/api/administrator/groups/g1") {
        return json({ group: { id: "g1", organization_id: "o1" } });
      }
      if (url.pathname === "/api/administrator/groups/g1/roles") return json({ roles: assigned });
      if (url.pathname === "/api/administrator/roles") {
        expect(url.searchParams.get("filter[organization]")).toBe("o1");
        return json(listAnswer(ORG_ROLES, url, { searchable: ["key", "name"] }));
      }
      throw new Error(`unrouted fetch: ${url.pathname}`);
    });
  }

  it("reads the org's whole role catalog and offers a role past position 200", async () => {
    serveGroup([]);
    renderWithIntl(<GroupRolesEditor groupId="g1" canAssign />);

    await waitFor(() => expect(values(lists().available)).toContain("r250"));
    expect(values(lists().available)).toHaveLength(250);
    expect(requestsTo("/api/administrator/roles")).toHaveLength(2);
  });

  it("keeps an assigned role the catalog does not hold when it is moved out", async () => {
    serveGroup([{ id: "r-outside", key: "legacy.role", name: "Legacy" }]);
    const user = userEvent.setup();
    renderWithIntl(<GroupRolesEditor groupId="g1" canAssign />);
    await waitFor(() => expect(values(lists().available)).toContain("r250"));

    expect(within(lists().assigned).getByText("legacy.role — Acme")).toBeInTheDocument();
    await user.selectOptions(lists().assigned, "r-outside");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(values(lists().assigned)).toEqual([]);
    expect(within(lists().available).getByText("legacy.role — Acme")).toBeInTheDocument();
  });
});

describe("Invitation role select (F-41)", () => {
  it("offers every role of the org, not the first 100", async () => {
    const orgRoles: Row[] = Array.from({ length: 150 }, (_, i) => ({
      id: `r${pad(i + 1)}`,
      name: `Role ${pad(i + 1)}`,
    }));
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.pathname === "/api/administrator/roles") {
        expect(url.searchParams.get("filter[organization]")).toBe("o1");
        return json(listAnswer(orgRoles, url, { searchable: ["name"] }));
      }
      // The invitations grid.
      return json({ items: [], page: 1, pageSize: 10, total: 0, sort: [] });
    });
    const user = userEvent.setup();
    renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate />);

    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).queryByText("Loading roles…")).toBeNull());

    await user.click(within(dialog).getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "Role 150" })).toBeInTheDocument();
    const pages = requestsTo("/api/administrator/roles").map((u) => u.searchParams.get("pageSize"));
    expect(pages).toEqual(["200"]);
  });
});

describe("Roles using a permission (F-41)", () => {
  it("lists every role holding the key, not the first 200", async () => {
    const holders: Row[] = Array.from({ length: 230 }, (_, i) => ({
      id: `r${pad(i + 1)}`,
      key: `app.role${pad(i + 1)}`,
      name: `Holder ${pad(i + 1)}`,
      organization_id: null,
    }));
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      expect(url.searchParams.get("filter[permission]")).toBe("admin.users.read");
      return json(listAnswer(holders, url, { searchable: ["key"] }));
    });
    renderWithIntl(
      <Sheet open>
        <SheetContent side="right">
          <RolesUsingPermissionPanel permissionKey="admin.users.read" />
        </SheetContent>
      </Sheet>,
    );

    expect(await screen.findByText("Holder 230")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(230);
  });
});
