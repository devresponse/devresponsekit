// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
function renderSidebar() {
  return render(
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
});
