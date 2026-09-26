// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyRevealDialog } from "@/components/api-keys/api-key-reveal";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * The one-time API-key reveal closes ONLY through its Done button (F-122).
 *
 * The plaintext is returned once and is unrecoverable: when this dialog
 * closes, the caller clears it (account panel, keys grid) or navigates away
 * (new-key form). Escape, a click beside the dialog and the corner X each
 * closed it in one stray gesture, and the key then had to be rotated. The
 * one component serves all three reveal surfaces, so pinning it here covers
 * them all.
 */
function renderReveal() {
  const onClose = vi.fn();
  renderWithIntl(
    <ApiKeyRevealDialog
      secret="drk_test_secret"
      onClose={onClose}
      namespace="administrator.apiKeys.reveal"
    />,
  );
  return { onClose, dialog: screen.getByRole("dialog", { name: "Copy the key now" }) };
}

describe("ApiKeyRevealDialog", () => {
  it("ignores Escape", () => {
    const { onClose, dialog } = renderReveal();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("ignores a click outside the dialog", async () => {
    const { onClose } = renderReveal();
    // Radix arms its outside-pointer listener a tick after mounting (so the
    // click that opened the dialog cannot close it), and a Dialog dismisses
    // on the CLICK that completes an outside pointer-down, so send both.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("offers no corner close button, so Done is the only way out", async () => {
    const user = userEvent.setup();
    const { onClose, dialog } = renderReveal();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveTextContent("only time the full secret is shown");
  });
});
