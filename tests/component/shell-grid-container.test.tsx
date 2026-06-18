// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ShellGridContainer } from "@/components/app-shell/shell-grid-container";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("ShellGridContainer", () => {
  it("renders main with the supplied id and aria-label", () => {
    renderWithIntl(
      <ShellGridContainer variant="root" depth={0} mainId="m1" ariaLabel="Root">
        <span>main-content</span>
      </ShellGridContainer>,
    );
    const main = screen.getByText("main-content").closest("main");
    expect(main).toHaveAttribute("id", "m1");
    // ariaLabel labels the <main> landmark (not a bogus role="application").
    expect(screen.getByRole("main", { name: "Root" })).toBe(main);
  });

  it("hides regions when their content is missing", () => {
    renderWithIntl(
      <ShellGridContainer variant="root" depth={0}>
        <span>only-main</span>
      </ShellGridContainer>,
    );
    const grid = screen.getByText("only-main").closest('[data-variant="root"]')!;
    expect(grid.getAttribute("data-left-hidden")).toBe("true");
    expect(grid.getAttribute("data-right-hidden")).toBe("true");
    expect(grid.getAttribute("data-footer-hidden")).toBe("true");
  });

  it("respects parent-controlled visibility flags (§17.5)", () => {
    renderWithIntl(
      <ShellGridContainer
        variant="root"
        depth={0}
        left={<span>L</span>}
        right={<span>R</span>}
        footer={<span>F</span>}
        leftVisible={false}
        rightVisible
        footerVisible={false}
      >
        <span>main</span>
      </ShellGridContainer>,
    );
    expect(screen.queryByText("L")).toBeNull();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(screen.queryByText("F")).toBeNull();
  });

  it("renders header/left/right/footer landmarks when supplied", () => {
    renderWithIntl(
      <ShellGridContainer
        variant="root"
        depth={0}
        header={<span>H</span>}
        left={<span>L</span>}
        right={<span>R</span>}
        footer={<span>F</span>}
      >
        <span>M</span>
      </ShellGridContainer>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("H");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("F");
    expect(screen.getByLabelText("Primary navigation")).toHaveTextContent("L");
    expect(screen.getByLabelText("Inspector")).toHaveTextContent("R");
  });

  it("treats hidden mode as a hard hide regardless of visibility flag", () => {
    renderWithIntl(
      <ShellGridContainer
        variant="root"
        depth={0}
        left={<span>L</span>}
        leftMode="hidden"
        leftVisible
      >
        <span>main</span>
      </ShellGridContainer>,
    );
    expect(screen.queryByText("L")).toBeNull();
  });

  it("defaults to the header-first layout", () => {
    renderWithIntl(
      <ShellGridContainer variant="nested" depth={1}>
        <span>main</span>
      </ShellGridContainer>,
    );
    const grid = screen.getByText("main").closest("[data-layout]")!;
    expect(grid.getAttribute("data-layout")).toBe("header-first");
  });

  it("emits the sidebar-first layout attribute that drives the CSS area map", () => {
    renderWithIntl(
      <ShellGridContainer
        variant="nested"
        depth={1}
        layout="sidebar-first"
        header={<span>H</span>}
        left={<span>L</span>}
      >
        <span>main</span>
      </ShellGridContainer>,
    );
    const grid = screen.getByText("main").closest("[data-layout]")!;
    expect(grid.getAttribute("data-layout")).toBe("sidebar-first");
    // Regions render the same DOM in both layouts — only the grid
    // areas change (app-shell.css) — so landmarks must be unaffected.
    expect(screen.getByRole("banner")).toHaveTextContent("H");
    expect(screen.getByLabelText("Primary navigation")).toHaveTextContent("L");
  });
});
