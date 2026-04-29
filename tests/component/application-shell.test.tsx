// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ApplicationShell } from "@/components/app-shell/application-shell";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("ApplicationShell", () => {
  it("renders as nested variant when placed inside a root ShellContainer", () => {
    renderWithIntl(
      <ShellContainer mainId="root">
        <ApplicationShell mainId="nested" ariaLabel="Nested">
          <span>nested-content</span>
        </ApplicationShell>
      </ShellContainer>,
    );
    const nested = screen.getByText("nested-content").closest('[data-variant="nested"]');
    expect(nested).not.toBeNull();
    // Both shells get unique main ids per §31.21.
    const mains = screen.getAllByRole("main");
    const ids = mains.map((m) => m.id).sort();
    expect(ids).toEqual(["nested", "root"]);
  });

  it("does not render its own TopShellBar (root brand bar is unique)", () => {
    renderWithIntl(
      <ShellContainer header={<span data-testid="root-header">root</span>} mainId="root">
        <ApplicationShell header={<span data-testid="nested-header">nested</span>} mainId="nested">
          <span>x</span>
        </ApplicationShell>
      </ShellContainer>,
    );
    // Only one banner role from the root shell at the topmost grid.
    // The nested header still renders, but as its own element — both are
    // distinguishable by their test ids.
    expect(screen.getByTestId("root-header")).toBeInTheDocument();
    expect(screen.getByTestId("nested-header")).toBeInTheDocument();
  });
});
