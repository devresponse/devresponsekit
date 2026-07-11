// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("TopShellBar", () => {
  it("renders as a banner landmark with an accessible name", () => {
    renderWithIntl(
      <TopShellBar>
        <span data-testid="brand">Brand</span>
      </TopShellBar>,
    );
    const bar = screen.getByRole("banner", { name: /application brand bar/i });
    expect(bar).toContainElement(screen.getByTestId("brand"));
  });

  it("forwards an extra className", () => {
    renderWithIntl(<TopShellBar className="extra-bar">x</TopShellBar>);
    expect(screen.getByRole("banner")).toHaveClass("extra-bar");
  });

  it("carries the always-dark scope so the brand bar stays dark in both page themes", () => {
    // The `dark` class scopes the app's dark palette onto the header
    // subtree (globals.css `.dark { --… }` + `.sh-top-bar` alias
    // re-declaration), independent of the document theme — the source of
    // the bar's permanent contrast. Guards against an accidental removal.
    renderWithIntl(<TopShellBar>x</TopShellBar>);
    expect(screen.getByRole("banner")).toHaveClass("sh-top-bar", "dark");
  });
});

describe("ShellSkipLinks", () => {
  it("renders skip links to #main and #navigation", () => {
    renderWithIntl(<ShellSkipLinks />);
    const nav = screen.getByRole("navigation", { name: /skip links/i });
    expect(nav).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("#main");
    expect(hrefs).toContain("#navigation");
  });
});
