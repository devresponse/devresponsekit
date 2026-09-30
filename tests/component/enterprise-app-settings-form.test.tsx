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

/**
 * I-01 / R14: a caller without cross-org reach may move its app's audience only
 * onto a name under its org's slug, and the route refuses anything else with a
 * bare 403 that the form showed as "You don't have permission to view this
 * page." on a page the caller can view. The detail page passes the slug for
 * such a caller; the form hints the rule and puts that 403 on the audience.
 */
describe("EnterpriseAppSettingsForm audience namespace (R14)", () => {
  const ORG_APP = {
    ...APP,
    id: "acme.crm",
    ssoAudience: "devresponse-app:acme.crm",
    organizationSlug: "acme",
  };
  const renderConfined = (canManage = true) =>
    renderWithIntl(
      <EnterpriseAppSettingsForm app={ORG_APP} canManage={canManage} namespaceSlug="acme" />,
    );
  const hint = /must be an ID under your organization's slug.*\(for example acme\.crm\)/;

  it("hints the namespace under the audience for a confined manager only", () => {
    renderConfined();
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it("shows no hint to a superadmin or a read-only viewer", () => {
    const { unmount } = renderWithIntl(
      <EnterpriseAppSettingsForm app={ORG_APP} canManage namespaceSlug={null} />,
    );
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    unmount();
    renderConfined(false);
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
  });

  it("puts the 403 for an audience moved outside the slug on the audience field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderConfined();
    const audience = screen.getByRole("textbox", { name: "SSO audience" });
    await user.clear(audience);
    await user.type(audience, "devresponse-app:crm");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "Only a superadmin can register an SSO audience outside your organization's slug. The part after the last colon must be an ID under it, normally this application's ID, such as devresponse-app:acme.crm.",
      ),
    ).toBeInTheDocument();
    expect(audience).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a 403 with the stored audience unchanged a root error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderWithIntl(
      <EnterpriseAppSettingsForm
        app={{ ...ORG_APP, ssoAudience: "devresponse-app:crm" }}
        canManage
        namespaceSlug="acme"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to view this page.",
    );
  });
});
