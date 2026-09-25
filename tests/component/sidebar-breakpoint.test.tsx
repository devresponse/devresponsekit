// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  FlexSidebar,
  SidebarContent,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/flexsidebar";
import { DESKTOP_MEDIA_QUERY } from "@/lib/breakpoints";
import en from "@/messages/en.json";
import {
  installMatchMedia,
  matchesWidthQuery,
  readShellBreakpoints,
  type Viewport,
} from "../helpers/media-query";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-36: the sidebar trigger reaches the navigation at EVERY width, including
 * the `md` boundary.
 *
 * jsdom applies no CSS, so this test applies the two rules that decide
 * whether the in-flow rail can be seen, both read from their sources:
 *   - app-shell.css hides `.sh-left` under its mobile query (read from the
 *     file itself, not restated here);
 *   - the rail's own `hidden md:block` shows it only at Tailwind's `md`,
 *     which tests/unit/breakpoints.test.ts pins to DESKTOP_MEDIA_QUERY.
 * `matchMedia` answers for the given viewport, so `useIsMobile` picks the
 * branch it would pick in a browser. Where the rail cannot be seen, pressing
 * the trigger MUST open the drawer with the navigation in it.
 *
 * Before F-36, at 768px (and 767.5px) the CSS hid the rail, the hook still
 * said "desktop", and the trigger only collapsed the hidden rail. With a
 * 20px default font, 800px failed the same way: `md` (48rem) had moved to
 * 960px while both pixel queries stayed put.
 */
const LINK_NAME = "Workspace";

function Shell() {
  return (
    <SidebarProvider>
      <FlexSidebar collapsible="icon">
        <SidebarContent>
          <nav aria-label={en.shell.regions.primaryNavigation}>
            <a href="#workspace">{LINK_NAME}</a>
          </nav>
        </SidebarContent>
      </FlexSidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

/** The in-flow rail, if the desktop branch rendered. */
function inlineRail(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-side="left"][data-variant]');
}

/** Whether the in-flow rail would be visible in a browser at this viewport. */
function railVisible(rail: HTMLElement, viewport: Viewport): boolean {
  const { hidesSidebars } = readShellBreakpoints();
  if (matchesWidthQuery(hidesSidebars, viewport)) return false; // `.sh-left { display: none }`
  // The rail is `hidden <bp>:block`. Only `md` is modelled; anything else
  // must fail here rather than be guessed at.
  const shownAt = /(?:^|\s)(\w+):block(?:\s|$)/.exec(rail.className)?.[1];
  expect(rail.className.split(/\s+/)).toContain("hidden");
  expect(shownAt).toBe("md");
  return matchesWidthQuery(DESKTOP_MEDIA_QUERY, viewport);
}

/**
 * Renders the shell at `viewport` and returns how the navigation was
 * reached: in the visible rail, or in the drawer the trigger opened.
 */
async function reachNavigation(viewport: Viewport): Promise<"rail" | "drawer"> {
  restore = installMatchMedia(viewport);
  const { container } = renderWithIntl(<Shell />);
  const trigger = screen.getByRole("button", { name: en.shell.regions.toggleSidebar });

  const rail = inlineRail(container);
  if (rail && railVisible(rail, viewport)) {
    expect(within(rail).getByRole("link", { name: LINK_NAME })).toBeInTheDocument();
    // On desktop the trigger collapses the rail to icons; it opens nothing.
    fireEvent.click(trigger);
    expect(rail).toHaveAttribute("data-state", "collapsed");
    expect(screen.queryByRole("dialog")).toBeNull();
    return "rail";
  }

  // The rail cannot be seen, so the trigger is the only way in.
  fireEvent.click(trigger);
  const drawer = await screen.findByRole("dialog");
  expect(within(drawer).getByRole("link", { name: LINK_NAME })).toBeInTheDocument();
  return "drawer";
}

describe("SidebarTrigger at the md boundary (F-36)", () => {
  const viewports: Array<[string, Viewport]> = [
    ["767px", { width: 767 }],
    ["767.5px", { width: 767.5 }],
    ["767.98px", { width: 767.98 }],
    ["768px (iPad portrait)", { width: 768 }],
    ["769px", { width: 769 }],
    ["800px with a 20px default font", { width: 800, defaultFontSize: 20 }],
    ["960px with a 20px default font", { width: 960, defaultFontSize: 20 }],
  ];

  for (const [label, viewport] of viewports) {
    it(`primary navigation is reachable at ${label}`, async () => {
      await expect(reachNavigation(viewport)).resolves.toMatch(/^(rail|drawer)$/);
    });
  }

  it("opens the drawer at 767.5px", async () => {
    expect(await reachNavigation({ width: 767.5 })).toBe("drawer");
  });

  it("shows the rail at exactly 768px", async () => {
    expect(await reachNavigation({ width: 768 })).toBe("rail");
  });
});
