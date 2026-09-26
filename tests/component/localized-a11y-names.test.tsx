// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import fr from "@/messages/fr.json";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FlexSidebar, SidebarContent, SidebarProvider } from "@/components/ui/flexsidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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

  // F-117: the primitives defaulted to the English "Close", and ten call sites
  // (the Administrator detail sheets, the member/role/group dialogs, the
  // API-key reveal, the docs lightbox) never passed a label.
  it("labels the Dialog close button from the catalog when the caller passes none", async () => {
    renderFr(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(
      await screen.findByRole("button", { name: fr.common.dialogs.close }),
    ).toBeInTheDocument();
    expect(fr.common.dialogs.close).not.toBe("Close");
  });

  it("labels the Sheet close button from the catalog when the caller passes none", async () => {
    renderFr(
      <Sheet open>
        <SheetContent>
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(
      await screen.findByRole("button", { name: fr.common.dialogs.close }),
    ).toBeInTheDocument();
  });

  it("still lets a caller name the close button more specifically", async () => {
    renderFr(
      <Sheet open>
        <SheetContent closeLabel={fr.common.closeMenu}>
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(await screen.findByRole("button", { name: fr.common.closeMenu })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: fr.common.dialogs.close })).not.toBeInTheDocument();
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
