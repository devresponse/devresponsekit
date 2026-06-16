// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the shared OrganizationPicker (ADR-0002) — a Shadcn
 * combobox (Popover + cmdk Command) — and its two consumers' SUPERADMIN /
 * org-admin wiring in the new-role form. The picker is SUPERADMIN-only: an
 * org admin's scope is forced server-side and the form sends their own org
 * id without rendering the control.
 */
const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/roles",
  useSearchParams: () => new URLSearchParams(""),
}));

import { OrganizationPicker } from "@/app/[locale]/(secure)/app/administrator/_components/organization-picker";
import { NewRoleForm } from "@/app/[locale]/(secure)/app/administrator/roles/new/_new-role-form";

const fetchMock = vi.fn();

function jsonOk(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const ORGS = {
  items: [
    { id: "o1", slug: "acme", name: "Acme" },
    { id: "o2", slug: "globex", name: "Globex" },
  ],
  total: 2,
};

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}

function postCall() {
  return fetchMock.mock.calls.find(
    (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
  )!;
}

/** Opens the combobox once its org list has loaded (trigger un-disables). */
async function openPicker(user: ReturnType<typeof userEvent.setup>, trigger: Element) {
  await waitFor(() => expect(trigger).not.toBeDisabled());
  await user.click(trigger);
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrganizationPicker", () => {
  it("loads organizations and reports the chosen id", async () => {
    fetchMock.mockResolvedValue(jsonOk(ORGS));
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<OrganizationPicker value={null} onChange={onChange} />);

    await openPicker(user, container.querySelector("#organization-picker")!);
    await user.click(await screen.findByRole("option", { name: /Globex/ }));

    expect(onChange).toHaveBeenCalledWith("o2");
  });

  it("filters the options client-side by name or slug", async () => {
    fetchMock.mockResolvedValue(jsonOk(ORGS));
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<OrganizationPicker value={null} onChange={onChange} />);

    await openPicker(user, container.querySelector("#organization-picker")!);
    await user.type(screen.getByPlaceholderText("Search organizations…"), "globex");

    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Acme/ })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("option", { name: /Globex/ }));
    expect(onChange).toHaveBeenCalledWith("o2");
  });

  it("shows the selected org's label on the trigger", async () => {
    fetchMock.mockResolvedValue(jsonOk(ORGS));
    const { container } = renderWithIntl(<OrganizationPicker value="o1" onChange={vi.fn()} />);

    await waitFor(() =>
      expect(container.querySelector("#organization-picker")).toHaveTextContent("Acme (acme)"),
    );
  });

  it("offers a Global option that reports null when includeGlobal", async () => {
    fetchMock.mockResolvedValue(jsonOk(ORGS));
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <OrganizationPicker value="o1" onChange={onChange} includeGlobal />,
    );

    await openPicker(user, container.querySelector("#organization-picker")!);
    await user.click(await screen.findByRole("option", { name: /Global/ }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows an error when the organization list fails to load", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<OrganizationPicker value={null} onChange={vi.fn()} includeGlobal />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load organizations.");
  });
});

describe("NewRoleForm scope wiring", () => {
  it("an org admin posts their own org id and renders no picker", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "r9" }, 201));
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <NewRoleForm locale="en" showOrgPicker={false} defaultOrganizationId="o1" />,
    );

    expect(container.querySelector("#role-organization")).toBeNull();
    await user.type(container.querySelector("#role-key")!, "app.viewer");
    await user.type(container.querySelector("#role-name")!, "Viewer");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/roles",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(bodyOf(postCall())).toMatchObject({ organizationId: "o1" });
  });

  it("a SUPERADMIN can scope the role to a chosen org via the combobox", async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (String(url).includes("/api/administrator/organizations")) {
        return Promise.resolve(jsonOk(ORGS));
      }
      if (init?.method === "POST") return Promise.resolve(jsonOk({ id: "r9" }, 201));
      return Promise.resolve(jsonOk({}));
    });
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <NewRoleForm locale="en" showOrgPicker defaultOrganizationId={null} />,
    );

    await openPicker(user, container.querySelector("#role-organization")!);
    await user.click(await screen.findByRole("option", { name: /Globex/ }));
    await user.type(container.querySelector("#role-key")!, "app.viewer");
    await user.type(container.querySelector("#role-name")!, "Viewer");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/roles",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(bodyOf(postCall())).toMatchObject({ organizationId: "o2" });
  });

  it("a SUPERADMIN defaults to the Global (null) scope", async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (String(url).includes("/api/administrator/organizations")) {
        return Promise.resolve(jsonOk(ORGS));
      }
      if (init?.method === "POST") return Promise.resolve(jsonOk({ id: "r9" }, 201));
      return Promise.resolve(jsonOk({}));
    });
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <NewRoleForm locale="en" showOrgPicker defaultOrganizationId={null} />,
    );

    await waitFor(() => expect(container.querySelector("#role-organization")).not.toBeDisabled());
    await user.type(container.querySelector("#role-key")!, "app.viewer");
    await user.type(container.querySelector("#role-name")!, "Viewer");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(postCall())).toMatchObject({ organizationId: null });
  });
});
