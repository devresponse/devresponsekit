// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Skip-link targets must exist (review #104).
 *
 * The public shell renders with `leftVisible={false}`, so `#navigation`
 * is never in the document. The unconditional "Skip to navigation" anchor
 * was therefore a dead link that moved focus nowhere — and a keyboard user
 * has to tab THROUGH it to reach the page, so it is worse than absent.
 */
describe("ShellSkipLinks", () => {
  it("renders both links when the shell has a navigation region", () => {
    renderWithIntl(
      <>
        <ShellSkipLinks />
        <ShellContainer left={<span>nav</span>}>
          <span>content</span>
        </ShellContainer>
      </>,
    );
    const main = screen.getByRole("link", { name: "Skip to main content" });
    const nav = screen.getByRole("link", { name: "Skip to navigation" });
    expect(main).toHaveAttribute("href", "#main");
    expect(nav).toHaveAttribute("href", "#navigation");
    // Both anchors resolve to a real element.
    expect(document.querySelector("#main")).not.toBeNull();
    expect(document.querySelector("#navigation")).not.toBeNull();
  });

  it("omits the navigation link when the shell has no left region", () => {
    renderWithIntl(
      <>
        <ShellSkipLinks hasNavigation={false} />
        <ShellContainer leftVisible={false} left={<span>nav</span>}>
          <span>content</span>
        </ShellContainer>
      </>,
    );
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main",
    );
    expect(screen.queryByRole("link", { name: "Skip to navigation" })).toBeNull();
    // The premise of the omission: the target genuinely is not mounted.
    expect(document.querySelector("#navigation")).toBeNull();
  });
});
