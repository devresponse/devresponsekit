// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FlexSidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/flexsidebar";
import { installMatchMedia } from "../helpers/media-query";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * FlexSidebar is the container-friendly variant of the shadcn sidebar:
 * same provider/state machine, but the desktop panel is a single
 * in-flow column. These tests pin that layout contract:
 *   - nothing in the rendered tree uses fixed positioning or viewport
 *     height units (the parent container owns the vertical space);
 *   - the provider wrapper fills the parent (h-full), not min-h-svh;
 *   - the trigger flips data-state / data-collapsible so the icon
 *     collapse styling hooks engage.
 */
// SidebarTrigger's default screen-reader label now comes from the message
// catalog (review #106), so the tree needs the intl provider.
function renderSidebar() {
  return renderWithIntl(
    <SidebarProvider>
      <FlexSidebar collapsible="icon">
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Dashboard">Dashboard</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </FlexSidebar>
      <SidebarTrigger />
    </SidebarProvider>,
  );
}

describe("FlexSidebar", () => {
  it("renders in-flow: no fixed positioning or viewport-height classes anywhere", () => {
    const { container } = renderSidebar();
    const offenders = [...container.querySelectorAll("[class]")].filter((el) => {
      const cls = el.getAttribute("class") ?? "";
      return /\bfixed\b/.test(cls) || /\bh-svh\b/.test(cls) || /\bmin-h-svh\b/.test(cls);
    });
    expect(offenders).toEqual([]);
  });

  it("fills the parent container instead of the viewport", () => {
    const { container } = renderSidebar();
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute("class")).toContain("h-full");
    expect(wrapper.getAttribute("class")).toContain("min-h-0");
    expect(wrapper.getAttribute("class")).not.toContain("min-h-svh");
  });

  it("starts expanded and collapses to icon mode when the trigger is clicked", async () => {
    const { container } = renderSidebar();
    const root = container.querySelector("[data-state]")!;
    expect(root.getAttribute("data-state")).toBe("expanded");
    expect(root.getAttribute("data-collapsible")).toBe("");

    await userEvent.setup().click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(root.getAttribute("data-state")).toBe("collapsed");
    expect(root.getAttribute("data-collapsible")).toBe("icon");

    await userEvent.setup().click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(root.getAttribute("data-state")).toBe("expanded");
  });

  it("animates its own width between full and icon size (no spacer div)", () => {
    const { container } = renderSidebar();
    const column = container.querySelector("[data-state] > div")!;
    const cls = column.getAttribute("class") ?? "";
    // Tailwind 4 spelling (F-119): `w-[--x]` compiled to invalid CSS.
    // tests/unit/tailwind-v4-classes.test.ts pins what these compile to.
    const tokens = cls.split(/\s+/);
    expect(tokens).toContain("w-(--sidebar-width)");
    expect(tokens).toContain("group-data-[collapsible=icon]:w-(--sidebar-width-icon)");
    // Capped at the host: `.sh-left` is exactly --sidebar-width wide but
    // draws a 1px border inside it, so an uncapped column overflows it.
    expect(tokens).toContain("max-w-full");
    expect(cls).toContain("transition-[width]");
    // Exactly one child under the group wrapper — the original's
    // bg-transparent gap/spacer div must be gone.
    const root = container.querySelector("[data-state]")!;
    expect(root.children).toHaveLength(1);
  });

  it("caps the static (collapsible=none) column at its host the same way (F-119)", () => {
    const { container } = renderWithIntl(
      <SidebarProvider>
        <FlexSidebar collapsible="none">
          <SidebarContent />
        </FlexSidebar>
      </SidebarProvider>,
    );
    const column = container.querySelector(".bg-sidebar")!;
    expect(column.getAttribute("class")!.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-(--sidebar-width)", "max-w-full"]),
    );
  });

  it("persists state under a custom cookie name for nested providers", async () => {
    renderWithIntl(
      <SidebarProvider cookieName="administrator_sidebar_state">
        <FlexSidebar collapsible="icon">
          <SidebarContent />
        </FlexSidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(document.cookie).toContain("administrator_sidebar_state=false");
  });

  it("does not react to Ctrl+B when the keyboard shortcut is disabled", async () => {
    const { container } = renderWithIntl(
      <SidebarProvider keyboardShortcut={null}>
        <FlexSidebar collapsible="icon">
          <SidebarContent />
        </FlexSidebar>
      </SidebarProvider>,
    );
    const root = container.querySelector("[data-state]")!;
    expect(root.getAttribute("data-state")).toBe("expanded");
    await userEvent.setup().keyboard("{Control>}b{/Control}");
    expect(root.getAttribute("data-state")).toBe("expanded");
  });

  it("marks the active menu and sub-menu entries as the current page (F-120)", () => {
    // `data-active` only styles an entry; `aria-current` is what a screen
    // reader announces. Both buttons pass it through `asChild` to the link.
    renderWithIntl(
      <SidebarProvider>
        <FlexSidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <a href="#here">Here</a>
                </SidebarMenuButton>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton asChild isActive>
                      <a href="#here-sub">Sub here</a>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton href="#here-other">Sub other</SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="#elsewhere">Elsewhere</a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </FlexSidebar>
      </SidebarProvider>,
    );
    expect(screen.getByRole("link", { name: "Here" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sub here" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sub other" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Elsewhere" })).not.toHaveAttribute("aria-current");
  });

  it("sizes the phone drawer from --sidebar-width-mobile, not its content (F-119)", async () => {
    // The drawer's width was `w-[--sidebar-width]`, which Tailwind 4 compiles
    // to invalid CSS; the browser dropped it, and the fixed-position sheet
    // shrank to its longest label. It must now carry the v4 form, which
    // cn() keeps over the sheet's own `w-3/4`, and the 18rem mobile token.
    const restore = installMatchMedia({ width: 375 });
    try {
      renderSidebar();
      await userEvent.setup().click(screen.getByRole("button", { name: /toggle sidebar/i }));
      const drawer = await screen.findByRole("dialog");
      const tokens = (drawer.getAttribute("class") ?? "").split(/\s+/);
      expect(tokens).toContain("w-(--sidebar-width)");
      expect(tokens).not.toContain("w-3/4");
      expect(tokens.filter((t) => t.includes("[--"))).toEqual([]);
      expect(drawer.style.getPropertyValue("--sidebar-width")).toBe(
        "var(--sidebar-width-mobile, 18rem)",
      );
    } finally {
      restore();
    }
  });
});
