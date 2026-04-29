// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { CompactDensityWrapper } from "@/components/app-shell/compact-density-wrapper";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("CompactDensityWrapper", () => {
  it("defaults to compact density", () => {
    renderWithIntl(
      <CompactDensityWrapper>
        <span>child</span>
      </CompactDensityWrapper>,
    );
    const child = screen.getByText("child");
    expect(child.parentElement).toHaveAttribute("data-density", "compact");
  });

  it("honours an explicit density prop", () => {
    renderWithIntl(
      <CompactDensityWrapper density="comfortable">
        <span>cozy</span>
      </CompactDensityWrapper>,
    );
    expect(screen.getByText("cozy").parentElement).toHaveAttribute("data-density", "comfortable");
  });

  it("forwards an extra className", () => {
    renderWithIntl(
      <CompactDensityWrapper className="extra">
        <span>x</span>
      </CompactDensityWrapper>,
    );
    expect(screen.getByText("x").parentElement).toHaveClass("extra");
  });
});
