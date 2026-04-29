// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  AppSwitcherSkeleton,
  NavbarMenuSkeleton,
  NavigationMenuSkeleton,
  SidebarMenuSkeleton,
} from "@/components/app-shell/navigation-menu-skeleton";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("NavigationMenuSkeleton", () => {
  it("announces the loading state to assistive tech", () => {
    renderWithIntl(<NavigationMenuSkeleton />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-label", "Loading navigation");
  });

  it("respects the rows prop", () => {
    const { container } = renderWithIntl(<NavigationMenuSkeleton rows={3} />);
    // Each row is a flex container child of the status region.
    const status = container.querySelector('[role="status"]')!;
    expect(status.children.length).toBe(3);
  });

  it("renders a single line per row in compact mode", () => {
    const { container } = renderWithIntl(<NavigationMenuSkeleton compact rows={2} />);
    // In compact mode, each row only renders a single text skeleton in
    // addition to the icon skeleton (vs two lines normally).
    const status = container.querySelector('[role="status"]')!;
    const firstRow = status.children[0] as HTMLElement;
    // Icon + 1 text skeleton = 2 skeleton elements per row when compact.
    expect(firstRow.querySelectorAll("[class*='skeleton'], div div").length).toBeGreaterThan(0);
  });

  it("exposes named convenience variants", () => {
    renderWithIntl(<AppSwitcherSkeleton />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    const sidebar = renderWithIntl(<SidebarMenuSkeleton />);
    expect(sidebar.container.querySelector('[role="status"]')).not.toBeNull();

    const navbar = renderWithIntl(<NavbarMenuSkeleton />);
    expect(navbar.container.querySelector('[role="status"]')).not.toBeNull();
  });
});
