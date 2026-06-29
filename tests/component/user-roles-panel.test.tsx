// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the editable user-detail Roles tab and its RolePicker.
 *
 * The backend (`POST`/`DELETE /api/administrator/users/[id]/app-roles`) already
 * existed; these cover the new UI: the picker (org-scoped roles only, carrying
 * their own org), the `canAssign` gating, and the assign/remove wiring.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/users/u1",
  useSearchParams: () => new URLSearchParams(""),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));

// The confirm dialog auto-confirms so the DELETE path runs without a real overlay.
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: () => Promise.resolve(true) }),
}));

import { RolePicker } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_role-picker";
import { UserRolesPanel } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-roles-panel";

const USER_ID = "u1";
const ORG = "11111111-1111-4111-8111-111111111111";
const ROLE = "22222222-2222-4222-8222-222222222222";

const PICKER_ROLES = {
  items: [
    {
      id: ROLE,
      organization_id: ORG,
      organization_name: "Acme",
      key: "app.viewer",
      name: "Viewer",
    },
    // A GLOBAL role (no org) — must be filtered OUT of the assignable list.
    {
      id: "g0",
      organization_id: null,
      organization_name: null,
      key: "superuser",
      name: "Superuser",
    },
  ],
};

const ROLE_ROWS = {
  items: [
    {
      id: `${ORG}:${ROLE}`,
      role_id: ROLE,
      role_key: "app.viewer",
      role_name: "Viewer",
      role_description: null,
      organization_id: ORG,
      organization_slug: "acme",
      organization_name: "Acme",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  total: 1,
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
    if (u.includes(`/users/${USER_ID}/roles`)) return Promise.resolve(jsonOk(ROLE_ROWS));
    if (u.includes("/api/administrator/roles")) return Promise.resolve(jsonOk(PICKER_ROLES));
    return Promise.resolve(jsonOk({ items: [], total: 0 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("RolePicker", () => {
  it("lists only org-scoped roles and reports the chosen role", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<RolePicker value={null} onChange={onChange} />);

    const trigger = container.querySelector("#role-picker")!;
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);

    // The global role is filtered out; only the org-scoped one is offered.
    expect(screen.queryByRole("option", { name: /Superuser/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Viewer/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROLE, organization_id: ORG }),
    );
  });

  it("shows an error when the role list fails to load", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<RolePicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load roles.");
  });
});

describe("UserRolesPanel", () => {
  it("is read-only without admin.roles.assign (no assign or remove controls)", async () => {
    renderWithIntl(<UserRolesPanel userId={USER_ID} canAssign={false} />);
    await screen.findByText("Viewer"); // grid loaded
    expect(screen.queryByRole("button", { name: "Assign role" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("assigns a role, posting the role + its derived org", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UserRolesPanel userId={USER_ID} canAssign />);

    await user.click(await screen.findByRole("button", { name: "Assign role" }));
    await screen.findByText("Assign a role"); // dialog open
    const picker = await screen.findByRole("combobox");
    await waitFor(() => expect(picker).toBeEnabled(), { timeout: 4000 });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /Viewer/ }));
    await user.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(callOf("POST")).toBeTruthy());
    expect(callOf("POST")![0]).toContain(`/users/${USER_ID}/app-roles`);
    expect(bodyOf(callOf("POST")!)).toEqual({ roleId: ROLE, organizationId: ORG });
  });

  it("removes a role assignment via DELETE", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UserRolesPanel userId={USER_ID} canAssign />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(callOf("DELETE")).toBeTruthy());
    expect(callOf("DELETE")![0]).toContain(`/users/${USER_ID}/app-roles`);
    expect(bodyOf(callOf("DELETE")!)).toEqual({ roleId: ROLE, organizationId: ORG });
  });
});
