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

  /**
   * Review #103 — "Cancel" used to be `router.refresh()` alone, which
   * re-renders the SERVER tree but leaves React Hook Form's client state
   * untouched: the typed values, the validation error and the sticky
   * "saved" notice all survived, so the button did visibly nothing.
   */
  it("Cancel restores the server-supplied values", async () => {
    const user = userEvent.setup();
    render();
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Grace H");
    expect(name).toHaveValue("Grace H");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(name).toHaveValue("Ada");
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Ada L");
    // The server tree is still refreshed so a concurrent update lands.
    expect(refresh).toHaveBeenCalled();
  });

  it("Cancel clears the validation error and the sticky saved notice", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true"),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("textbox", { name: "Name" })).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
