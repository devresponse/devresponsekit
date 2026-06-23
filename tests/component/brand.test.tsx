// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DEFAULT_BRAND, getBrand } from "@/config/brand";
import { BrandLogo } from "@/components/brand/brand-logo";

/**
 * White-label Phase 0: the brand name/logo/favicon are single-sourced through
 * {@link getBrand} + {@link BrandLogo} (replacing scattered literals + the
 * `common.appName` i18n key). These pin the default-brand contract + the
 * wordmark fallback so a future per-tenant resolver can't silently regress it.
 */
describe("getBrand (default brand)", () => {
  it("returns the built-in default brand with a derived short name + existing favicon", () => {
    const brand = getBrand();
    expect(brand).toBe(DEFAULT_BRAND);
    expect(brand.id).toBe("default");
    expect(brand.name.length).toBeGreaterThan(0);
    // shortName is the first token of the full name.
    expect(brand.shortName).toBe(brand.name.split(/\s+/)[0]);
    expect(brand.favicon).toBe("/favicon.png");
    // Phase 0 has no image logo — the brand renders as its wordmark.
    expect(brand.logo).toEqual({ light: null, dark: null });
  });
});

describe("BrandLogo", () => {
  it("renders the full name by default and the short name when compact", () => {
    const { container, rerender } = render(<BrandLogo />);
    expect(container.textContent).toBe(getBrand().name);
    rerender(<BrandLogo compact />);
    expect(container.textContent).toBe(getBrand().shortName);
  });

  it("applies the className to the wordmark span", () => {
    const { container } = render(<BrandLogo className="text-sm font-semibold" />);
    const span = container.querySelector("span");
    expect(span?.className).toBe("text-sm font-semibold");
  });
});
