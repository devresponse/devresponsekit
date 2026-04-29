// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShellVisibilityToggle } from "@/components/app-shell/shell-visibility-toggle";
import { useAppShellStore } from "@/stores/app-shell-store";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("ShellVisibilityToggle", () => {
  afterEach(() => {
    useAppShellStore.getState().resetScope("root");
    useAppShellStore.getState().resetScope("workspace");
  });

  it("renders an accessible toggle button with aria-pressed reflecting visibility", () => {
    renderWithIntl(<ShellVisibilityToggle scope="root" region="left" />);
    const button = screen.getByRole("button", { name: /hide left sidebar/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles the underlying store on click and updates accessible name", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ShellVisibilityToggle scope="root" region="right" />);

    const button = screen.getByRole("button", { name: /hide right sidebar/i });
    await user.click(button);

    expect(useAppShellStore.getState().visibility.root.rightVisible).toBe(false);
    // Accessible name flips to "Show right sidebar" after the state change.
    expect(screen.getByRole("button", { name: /show right sidebar/i })).toBeInTheDocument();
  });

  it("scopes visibility per shell (root vs workspace)", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <>
        <ShellVisibilityToggle scope="root" region="footer" />
        <ShellVisibilityToggle scope="workspace" region="footer" />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: /footer/i });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    expect(useAppShellStore.getState().visibility.root.footerVisible).toBe(false);
    expect(useAppShellStore.getState().visibility.workspace.footerVisible).toBe(true);
  });
});
