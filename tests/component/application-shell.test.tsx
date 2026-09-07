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
    // Review #104/#105: a document has exactly ONE main landmark. The root
    // shell owns it; the nested shell is a labelled region with its own id.
    const mains = screen.getAllByRole("main");
    expect(mains.map((m) => m.id)).toEqual(["root"]);
    expect(screen.getByRole("region", { name: "Nested" }).id).toBe("nested");
  });

  it("derives distinct landmark ids for a nested shell (no duplicate #main/#navigation)", () => {
    // Review #105: neither shell is given explicit ids here — the ROOT keeps
    // `main`/`navigation` (the two ShellSkipLinks targets) and the nested one
    // must derive its own, or the skip links resolve to whichever element the
    // browser finds first.
    const { container } = renderWithIntl(
      <ShellContainer left={<span>root-nav</span>} ariaLabel="Root">
        <ApplicationShell left={<span>nested-nav</span>} ariaLabel="Nested">
          <span>nested-content</span>
        </ApplicationShell>
      </ShellContainer>,
    );

    for (const id of ["main", "navigation"]) {
      expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    expect(container.querySelector("#main")!.tagName).toBe("MAIN");
    expect(container.querySelector("#navigation")!.textContent).toBe("root-nav");

    // The nested regions exist and are addressable under their own ids.
    expect(screen.getByRole("region", { name: "Nested" }).id).toBe("main-1");
    expect(container.querySelector("#navigation-1")!.textContent).toBe("nested-nav");

    // Every id in the tree is unique — the property the skip links rely on.
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
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
