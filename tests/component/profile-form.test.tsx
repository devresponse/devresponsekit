// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "@/app/[locale]/(secure)/app/account/profile/_profile-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, prefetch: vi.fn() }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = () =>
  renderWithIntl(
    <ProfileForm initial={{ displayName: "Ada L", name: "Ada", email: "ada@x.com" }} />,
  );

describe("ProfileForm", () => {
  it("requires name (not display name)", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Display name" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("blocks save when the name is emptied", async () => {
    const user = userEvent.setup();
    render();
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes and shows the saved confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " B");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/profile",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
