// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the editable user-detail Groups tab and its GroupPicker.
 *
 * The backend (`POST`/`DELETE /api/administrator/users/[id]/groups`) already
 * existed; these cover the new UI: the picker (excludes current memberships),
 * the `canManage` gating, and the add/remove wiring.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/users/u1",
  useSearchParams: () => new URLSearchParams(""),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: () => Promise.resolve(true) }),
}));

import { GroupPicker } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_group-picker";
import { UserGroupsPanel } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-groups-panel";

const USER_ID = "u1";
const ORG = "11111111-1111-4111-8111-111111111111";
const G1 = "22222222-2222-4222-8222-222222222222"; // Engineering — user is already a member
const G2 = "33333333-3333-4333-8333-333333333333"; // Operations — addable

const USER_GROUPS = [{ id: G1, organization_id: ORG, key: "eng", name: "Engineering" }];
const PICKER_GROUPS = {
  items: [
    { id: G1, organization_id: ORG, key: "eng", name: "Engineering" },
    { id: G2, organization_id: ORG, key: "ops", name: "Operations" },
  ],
};

const fetchMock = vi.fn();

function jsonOk(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}
function callOf(method: string) {
  return fetchMock.mock.calls.find(
    (c) => (c[1] as { method?: string } | undefined)?.method === method,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "POST") return Promise.resolve(jsonOk({ ok: true }, 201));
    if (init?.method === "DELETE") return Promise.resolve(jsonOk({ ok: true }, 200));
    if (u.includes(`/users/${USER_ID}/groups`))
      return Promise.resolve(jsonOk({ groups: USER_GROUPS }));
    if (u.includes("/api/administrator/groups")) return Promise.resolve(jsonOk(PICKER_GROUPS));
    return Promise.resolve(jsonOk({ groups: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GroupPicker", () => {
  it("lists groups, excludes current memberships, and reports the choice", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <GroupPicker value={null} onChange={onChange} excludeIds={[G1]} />,
    );

    const trigger = container.querySelector("#group-picker")!;
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);

    // Engineering (already a member) is excluded; only Operations is offered.
    expect(screen.queryByRole("option", { name: /Engineering/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Operations/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: G2 }));
  });

  it("shows an error when the group list fails to load", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<GroupPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load groups.");
  });
});

describe("UserGroupsPanel", () => {
  it("is read-only without admin.groups.assign (no add or remove controls)", async () => {
    renderWithIntl(<UserGroupsPanel userId={USER_ID} canManage={false} />);
    await screen.findByText("Engineering"); // list loaded
    expect(screen.queryByRole("button", { name: "Add to group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("adds the user to a group, posting the chosen groupId", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UserGroupsPanel userId={USER_ID} canManage />);

    await user.click(await screen.findByRole("button", { name: "Add to group" }));
    await screen.findByText("Add to a group"); // dialog open
    const picker = await screen.findByRole("combobox");
    await waitFor(() => expect(picker).toBeEnabled(), { timeout: 4000 });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /Operations/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(callOf("POST")).toBeTruthy());
    expect(callOf("POST")![0]).toContain(`/users/${USER_ID}/groups`);
    expect(bodyOf(callOf("POST")!)).toEqual({ groupId: G2 });
  });

  it("removes the user from a group via DELETE", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UserGroupsPanel userId={USER_ID} canManage />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(callOf("DELETE")).toBeTruthy());
    expect(callOf("DELETE")![0]).toContain(`/users/${USER_ID}/groups`);
    expect(bodyOf(callOf("DELETE")!)).toEqual({ groupId: G1 });
  });
});
