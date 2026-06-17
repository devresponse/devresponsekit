// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewPermissionForm } from "@/app/[locale]/(secure)/app/administrator/permissions/new/_new-permission-form";
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

describe("NewPermissionForm", () => {
  it("marks the key field required (and description not)", () => {
    renderWithIntl(<NewPermissionForm locale="en" />);
    expect(screen.getByRole("textbox", { name: "Key" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("shows a field error and marks the key invalid for a bad key", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewPermissionForm locale="en" />);
    await user.type(screen.getByRole("textbox", { name: "Key" }), "bad key!");
    await user.click(screen.getByRole("button", { name: "Create permission" }));

    expect(
      await screen.findByText("Use only letters, numbers, and the characters . _ - :"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Key" })).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 409 onto the key field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    renderWithIntl(<NewPermissionForm locale="en" />);
    await user.type(screen.getByRole("textbox", { name: "Key" }), "feature.read");
    await user.click(screen.getByRole("button", { name: "Create permission" }));

    expect(await screen.findByText("That key is already in use.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
