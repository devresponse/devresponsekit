// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("ShellContainer", () => {
  it("wraps children in the shell frame and exposes the main landmark", () => {
    renderWithIntl(
      <ShellContainer mainId="root-main" ariaLabel="Root shell">
        <span>page</span>
      </ShellContainer>,
    );
    expect(screen.getByText("page").closest("main")).toHaveAttribute("id", "root-main");
    expect(screen.getByRole("main", { name: "Root shell" })).toBeInTheDocument();
  });

  it("renders branding above the grid", () => {
    renderWithIntl(
      <ShellContainer branding={<span>BRAND</span>}>
        <span>x</span>
      </ShellContainer>,
    );
    expect(screen.getByText("BRAND")).toBeInTheDocument();
  });

  it("defaults all sidebars and footer to visible (§17.5)", () => {
    renderWithIntl(
      <ShellContainer left={<span>L</span>} right={<span>R</span>} footer={<span>F</span>}>
        <span>m</span>
      </ShellContainer>,
    );
    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(screen.getByText("F")).toBeInTheDocument();
  });
});
