// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleSettingsForm } from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-settings-form";
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

const render = () =>
  renderWithIntl(
    <RoleSettingsForm
      roleId="r1"
      initialKey="support"
      initialName="Support"
      initialDescription={null}
      canUpdate
    />,
  );

describe("RoleSettingsForm", () => {
  it("requires name and shows the key read-only", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
    const key = screen.getByRole("textbox", { name: "Key" });
    expect(key).toHaveAttribute("readonly");
    expect(key).toHaveValue("support");
  });

  it("blocks the save when name is emptied", async () => {
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
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/roles/r1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    // F-39: only the edited field; the untouched description is not re-sent.
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ name: "Support Team" });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
