// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewOrganizationForm } from "@/app/[locale]/(secure)/app/administrator/organizations/new/_new-organization-form";
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

describe("NewOrganizationForm", () => {
  it("marks slug and name required", () => {
    renderWithIntl(<NewOrganizationForm locale="en" />);
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
  });

  it("shows a field error and marks the slug invalid for a bad slug", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewOrganizationForm locale="en" />);
    await user.type(screen.getByRole("textbox", { name: "Slug" }), "Bad Slug");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Acme");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(
      await screen.findByText("Use lowercase letters, numbers, and hyphens."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 409 onto the slug field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 409, json: async () => ({}) });
    renderWithIntl(<NewOrganizationForm locale="en" />);
    await user.type(screen.getByRole("textbox", { name: "Slug" }), "acme");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Acme");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(await screen.findByText("That slug is already in use.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("posts and navigates on a valid submit", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: "org-9" }) });
    renderWithIntl(<NewOrganizationForm locale="en" />);
    await user.type(screen.getByRole("textbox", { name: "Slug" }), "acme");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Acme");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ slug: "acme", name: "Acme", isDefault: false });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/en/app/administrator/organizations/org-9"),
    );
  });
});
