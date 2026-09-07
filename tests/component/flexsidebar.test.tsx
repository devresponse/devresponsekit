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
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/flexsidebar";
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
    expect(cls).toContain("w-[--sidebar-width]");
    expect(cls).toContain("group-data-[collapsible=icon]:w-[--sidebar-width-icon]");
    expect(cls).toContain("transition-[width]");
    // Exactly one child under the group wrapper — the original's
    // bg-transparent gap/spacer div must be gone.
    const root = container.querySelector("[data-state]")!;
    expect(root.children).toHaveLength(1);
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
});
