// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the shared OrganizationPicker (ADR-0002) and its two
 * consumers' SUPERADMIN/org-admin wiring in the new-role form. The picker is
 * SUPERADMIN-only: an org admin's scope is forced server-side and the form
 * sends their own org id without rendering the control.
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
    const { container } = renderWithIntl(<OrganizationPicker value={null} onChange={onChange} />);

    const select = container.querySelector("#organization-picker") as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(screen.getByRole("option", { name: "Acme (acme)" })).toBeInTheDocument();

    await userEvent.setup().selectOptions(select, "o2");
    expect(onChange).toHaveBeenCalledWith("o2");
  });

  it("offers a Global option that reports null when includeGlobal", async () => {
    fetchMock.mockResolvedValue(jsonOk(ORGS));
    const onChange = vi.fn();
    const { container } = renderWithIntl(
      <OrganizationPicker value="o1" onChange={onChange} includeGlobal />,
    );

    const select = container.querySelector("#organization-picker") as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(screen.getByRole("option", { name: "Global (all organizations)" })).toBeInTheDocument();

    await userEvent.setup().selectOptions(select, "");
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

  it("a SUPERADMIN can scope the role to a chosen org via the picker", async () => {
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

    const picker = container.querySelector("#role-organization") as HTMLSelectElement;
    await waitFor(() => expect(picker).not.toBeDisabled());
    await user.type(container.querySelector("#role-key")!, "app.viewer");
    await user.type(container.querySelector("#role-name")!, "Viewer");
    await user.selectOptions(picker, "o2");
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

    await waitFor(() => expect(postCall).not.toThrow());
    expect(bodyOf(postCall())).toMatchObject({ organizationId: null });
  });
});
