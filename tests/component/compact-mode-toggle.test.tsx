// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompactModeToggle } from "@/components/app-shell/compact-mode-toggle";
import { useAppShellStore } from "@/stores/app-shell-store";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("CompactModeToggle", () => {
  afterEach(() => {
    useAppShellStore.getState().setDensity("compact");
  });

  it("renders an accessible toggle reflecting the current density", () => {
    renderWithIntl(<CompactModeToggle />);
    const button = screen.getByRole("button", { name: /compact mode/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("flips density when clicked", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CompactModeToggle />);
    const button = screen.getByRole("button", { name: /compact mode/i });
    await user.click(button);
    expect(useAppShellStore.getState().density).toBe("comfortable");
    await user.click(button);
    expect(useAppShellStore.getState().density).toBe("compact");
  });
});
