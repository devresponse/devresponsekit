// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationSettingsForm } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-settings-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = () =>
  renderWithIntl(
    <OrganizationSettingsForm
      orgId="o1"
      initialSlug="acme"
      initialName="Acme"
      initialStatus="active"
      initialIsDefault={false}
      canUpdate
    />,
  );

describe("OrganizationSettingsForm", () => {
  it("requires slug and name", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
  });

  it("maps a 409 onto the slug field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " Corp");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("That slug is already in use.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAttribute("aria-invalid", "true");
  });

  it("PATCHes and shows the saved confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " Corp");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/organizations/o1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const body = JSON.parse(
      (
        fetchMock.mock.calls.find(
          (c) => (c[1] as { method?: string })?.method === "PATCH",
        )?.[1] as {
          body: string;
        }
      ).body,
    );
    expect(body).toMatchObject({ slug: "acme", name: "Acme Corp", status: "active" });
    expect(await screen.findByRole("status")).toHaveTextContent("Organization updated.");
  });
});
