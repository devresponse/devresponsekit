// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { MobileSidebarTrigger } from "@/components/app-shell/mobile-sidebar-trigger";
import { useAppShellStore } from "@/stores/app-shell-store";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("MobileSidebarTrigger", () => {
  beforeEach(() => {
    useAppShellStore.getState().resetScope("root");
  });

  it("toggles the left region in the supplied scope and reflects state via aria-expanded", () => {
    renderWithIntl(<MobileSidebarTrigger scope="root" />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "navigation");

    fireEvent.click(button);
    expect(useAppShellStore.getState().visibility.root.leftVisible).toBe(false);
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(useAppShellStore.getState().visibility.root.leftVisible).toBe(true);
  });

  it("is hidden on md+ viewports via the md:hidden utility", () => {
    renderWithIntl(<MobileSidebarTrigger />);
    expect(screen.getByRole("button").className).toMatch(/\bmd:hidden\b/);
  });
});
