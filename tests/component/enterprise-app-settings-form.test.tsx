// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseAppSettingsForm } from "@/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/_enterprise-app-settings-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, prefetch: vi.fn() }),
}));

const fetchMock = vi.fn();
const APP = {
  id: "acme.app",
  label: "Acme",
  description: null,
  origin: "https://acme.com",
  subdomain: "acme",
  ssoAudience: "acme:aud",
  status: "available",
  sortOrder: 100,
  organizationSlug: null,
};

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = (canManage = true) =>
  renderWithIntl(<EnterpriseAppSettingsForm app={APP} canManage={canManage} />);

describe("EnterpriseAppSettingsForm", () => {
  it("marks the create-required fields and not the optional description", () => {
    render();
    for (const name of ["Label", "Origin", "Subdomain", "SSO audience"]) {
      expect(screen.getByRole("textbox", { name })).toHaveAttribute("aria-required", "true");
    }
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("PATCHes and shows the saved confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Label" }), " Inc");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/enterprise-apps/acme.app",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Application updated.");
  });

  it("maps a server invalid_origin (400) onto the origin field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 400, json: async () => ({ error: "invalid_origin" }) });
    render();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Origin must be an HTTPS URL with no path."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Origin" })).toHaveAttribute("aria-invalid", "true");
  });

  it("renders read-only (no save button) without manage permission", () => {
    render(false);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Label" })).toBeDisabled();
  });
});
