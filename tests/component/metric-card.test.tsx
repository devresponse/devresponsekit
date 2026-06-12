// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MetricCard } from "@/app/[locale]/(secure)/app/administrator/_components/metric-card";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Presentational contract of the overview KPI card: locale-aware
 * number formatting, decorative icon, optional hint, and the
 * link-vs-static rendering split.
 */
describe("MetricCard", () => {
  it("formats the value with the active locale and renders label + hint", () => {
    renderWithIntl(
      <MetricCard
        label="Users"
        value={12345}
        hint="12 active · 3 pending"
        icon="users"
        locale="en"
      />,
    );
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("12 active · 3 pending")).toBeInTheDocument();
  });

  it("renders the allow-listed icon as decorative only", () => {
    const { container } = renderWithIntl(
      <MetricCard label="Roles" value={7} icon="shield" locale="en" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("wraps the card in a locale link when href is given", () => {
    renderWithIntl(
      <MetricCard
        label="Organizations"
        value={5}
        href="/app/administrator/organizations"
        locale="en"
      />,
    );
    const link = screen.getByRole("link", { name: "Organizations" });
    expect(link.getAttribute("href")).toContain("/app/administrator/organizations");
  });

  it("renders a static card without a link when href is omitted", () => {
    renderWithIntl(<MetricCard label="Permissions" value={24} locale="en" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("24")).toBeInTheDocument();
  });
});
