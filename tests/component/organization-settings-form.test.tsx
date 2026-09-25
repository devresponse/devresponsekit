// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationSettingsForm } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-settings-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = ({
  isDefault = false,
  isResolvedDefault = isDefault,
}: { isDefault?: boolean; isResolvedDefault?: boolean } = {}) =>
  renderWithIntl(
    <OrganizationSettingsForm
      orgId="o1"
      initialSlug="acme"
      initialName="Acme"
      initialStatus="active"
      initialIsDefault={isDefault}
      isResolvedDefault={isResolvedDefault}
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

  it("F-09: a 409 last_superadmin (suspending the org holding the last superuser grant) is a root error, not a slug error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "last_superadmin", message: "errors.last_superadmin" }),
    });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " Corp");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This is the last platform superadmin",
    );
    expect(screen.getByRole("textbox", { name: "Slug" })).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
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
    // F-39: only the edited field; the untouched slug/status/default are not re-sent.
    expect(body).toEqual({ name: "Acme Corp" });
    expect(await screen.findByRole("status")).toHaveTextContent("Organization updated.");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /**
   * F-40: the default flag is THE routing target for unmapped sign-ups, and it
   * can only be moved: the form says so, locks it on the current default, and
   * warns that a slug edit breaks slug-based links and env configuration.
   */
  describe("the default organization (F-40)", () => {
    const checkbox = () => screen.getByRole("checkbox", { name: /set as default organization/i });

    it("on the default org the flag is read-only, with how to move it", () => {
      render({ isDefault: true });
      expect(checkbox()).toBeDisabled();
      expect(checkbox()).toBeChecked();
      expect(checkbox()).toHaveAccessibleDescription(/This is the default organization/);
      expect(checkbox()).toHaveAccessibleDescription(/set it on another organization/);
    });

    it("a legacy EXTRA flag (flagged, but not where sign-ups resolve) says so and can be unticked", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
      render({ isDefault: true, isResolvedDefault: false });
      expect(checkbox()).toBeChecked();
      expect(checkbox()).toBeEnabled();
      expect(checkbox()).toHaveAccessibleDescription(/also flagged as the default/);
      expect(checkbox()).not.toHaveAccessibleDescription(/This is the default organization/);

      await user.click(checkbox());
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ isDefault: false });
    });

    it("on another org the checkbox says it MOVES the default and where sign-ups land", () => {
      render();
      expect(checkbox()).toBeEnabled();
      expect(checkbox()).toHaveAccessibleDescription(/join the default organization/);
      expect(checkbox()).toHaveAccessibleDescription(/moves it from the current one/);
    });

    it("editing the slug warns about /sign-in links and slug-configured env vars", async () => {
      const user = userEvent.setup();
      render();
      expect(screen.queryByRole("note")).not.toBeInTheDocument();

      const slug = screen.getByRole("textbox", { name: "Slug" });
      await user.clear(slug);
      await user.type(slug, "acme-corp");

      const note = screen.getByRole("note");
      expect(note).toHaveTextContent("/sign-in/acme links");
      expect(note).toHaveTextContent("MCP_REGISTRATION_DEFAULT_ORG");

      // Back to the saved slug: nothing to warn about.
      await user.clear(slug);
      await user.type(slug, "acme");
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("a 409 organization_is_default is a root error, not a slug error", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: "organization_is_default",
          message: "errors.organization_is_default",
        }),
      });
      render();
      await user.type(screen.getByRole("textbox", { name: "Name" }), " Corp");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The default organization cannot be unset.",
      );
      expect(screen.getByRole("textbox", { name: "Slug" })).not.toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
  });
});
