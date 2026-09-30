// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EraseUserButton } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_erase-button";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-151: the erase dialog on the user detail page. Erasure cannot be undone,
 * so the action stays disabled until BOTH confirmations hold: the
 * acknowledgement box and the account's address typed out (compared
 * case-insensitively, as the route compares `confirmEmail`). A refusal from
 * the route is reported and refreshes nothing; a success refreshes the page
 * from the server.
 */
const notify = vi.fn().mockResolvedValue(undefined);
const refresh = vi.fn();
vi.mock("@/components/ui/dialog-manager", () => ({ useDialogs: () => ({ notify }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
const USER_ID = "11111111-1111-4111-8111-111111111151";

beforeEach(() => {
  fetchMock.mockReset();
  notify.mockClear();
  refresh.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function openDialog() {
  renderWithIntl(<EraseUserButton userId={USER_ID} email="Target@Example.com" />);
  fireEvent.click(screen.getByRole("button", { name: "Erase personal data" }));
  return screen.findByRole("button", { name: "Erase permanently" });
}

describe("EraseUserButton (F-151)", () => {
  it("stays disabled until the box is ticked AND the address is typed", async () => {
    const action = await openDialog();
    expect(action).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /permanent and will be audited/ }));
    expect(action).toBeDisabled();

    const input = screen.getByLabelText("Type the user's email address to confirm");
    fireEvent.change(input, { target: { value: "someone@else.com" } });
    expect(action).toBeDisabled();

    fireEvent.change(input, { target: { value: " target@example.COM " } });
    expect(action).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the typed address, then refreshes the page", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const action = await openDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: /permanent and will be audited/ }));
    fireEvent.change(screen.getByLabelText("Type the user's email address to confirm"), {
      target: { value: "target@example.com" },
    });
    fireEvent.click(action);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/administrator/users/${USER_ID}/erase`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmEmail: "target@example.com" }),
    });
    expect(notify).toHaveBeenCalledWith({
      description: "The user's personal data has been erased.",
    });
  });

  it("reports a refusal and refreshes nothing", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "not_deactivated" }) });
    const action = await openDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: /permanent and will be audited/ }));
    fireEvent.change(screen.getByLabelText("Type the user's email address to confirm"), {
      target: { value: "target@example.com" },
    });
    fireEvent.click(action);

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({
        description: "Could not erase the user's personal data.",
        variant: "destructive",
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
