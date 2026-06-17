// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewEnterpriseAppForm } from "@/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, prefetch: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "ID" }), "acme.app");
  await user.type(screen.getByRole("textbox", { name: "Label" }), "Acme");
  await user.type(screen.getByRole("textbox", { name: "Origin" }), "https://acme.com");
  await user.type(screen.getByRole("textbox", { name: "Subdomain" }), "acme");
  await user.type(screen.getByRole("textbox", { name: "SSO audience" }), "acme:aud");
}

describe("NewEnterpriseAppForm", () => {
  it("marks the required fields and not the optional ones", () => {
    renderWithIntl(<NewEnterpriseAppForm locale="en" />);
    for (const name of ["ID", "Label", "Origin", "Subdomain", "SSO audience"]) {
      expect(screen.getByRole("textbox", { name })).toHaveAttribute("aria-required", "true");
    }
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
    expect(screen.getByRole("spinbutton", { name: "Sort order" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("blocks submit and marks required controls invalid on an empty submit", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewEnterpriseAppForm locale="en" />);
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "ID" })).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByRole("textbox", { name: "Origin" })).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a server invalid_origin (400) onto the origin field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 400, json: async () => ({ error: "invalid_origin" }) });
    renderWithIntl(<NewEnterpriseAppForm locale="en" />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create application" }));

    expect(
      await screen.findByText("Origin must be an HTTPS URL with no path."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Origin" })).toHaveAttribute("aria-invalid", "true");
    expect(push).not.toHaveBeenCalled();
  });

  it("posts and navigates to the created app on a valid submit", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: "acme.app" }) });
    renderWithIntl(<NewEnterpriseAppForm locale="en" />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({
      id: "acme.app",
      label: "Acme",
      origin: "https://acme.com",
      subdomain: "acme",
      sso_audience: "acme:aud",
      sort_order: 100,
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/en/app/administrator/enterprise-apps/acme.app"),
    );
  });
});
