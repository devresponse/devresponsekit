// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import fr from "@/messages/fr.json";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { FlexSidebar, SidebarContent, SidebarProvider } from "@/components/ui/flexsidebar";
import { SidebarRail, SidebarTrigger } from "@/components/ui/sidebar";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Accessible names in the shell chrome come from the message catalog
 * (review #106).
 *
 * These controls are icon-only, so the `aria-label` / `sr-only` text IS
 * their accessible name — the only thing a screen-reader user hears. They
 * shipped hardcoded English inside a fully localized UI, which the axe
 * sweeps cannot catch (an English name is a valid name). Asserting against
 * the FRENCH catalog is the check that fails the moment a literal comes
 * back: an English string in `fr` markup is unambiguous.
 */
function renderFr(ui: React.ReactElement) {
  return renderWithIntl(ui, { locale: "fr", messages: fr as Record<string, unknown> });
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("localized accessible names", () => {
  it("labels the theme toggle from the catalog", () => {
    renderFr(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: fr.common.switchToDarkTheme })).toBeInTheDocument();
    expect(fr.common.switchToDarkTheme).not.toBe("Switch to dark theme");
  });

  it("labels the sidebar trigger and rail from the catalog", () => {
    renderFr(
      <SidebarProvider>
        <SidebarTrigger />
        <SidebarRail />
      </SidebarProvider>,
    );
    const named = screen.getAllByRole("button", { name: fr.shell.regions.toggleSidebar });
    expect(named).toHaveLength(2);
  });

  describe("mobile sheet", () => {
    beforeEach(() => {
      // Force the mobile branch so the Sheet drawer renders.
      window.matchMedia = ((query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    });

    it("names the drawer from the catalog", async () => {
      renderFr(
        <SidebarProvider defaultOpen>
          <FlexSidebar collapsible="icon">
            <SidebarContent />
          </FlexSidebar>
          <SidebarTrigger />
        </SidebarProvider>,
      );
      // The Sheet is closed until the trigger fires; opening it via the
      // provider state is what the trigger does.
      screen.getByRole("button", { name: fr.shell.regions.toggleSidebar }).click();
      expect(await screen.findByText(fr.shell.regions.sidebar)).toBeInTheDocument();
      expect(screen.getByText(fr.shell.regions.sidebarDescription)).toBeInTheDocument();
      expect(fr.shell.regions.sidebar).not.toBe("Sidebar");
    });
  });
});
