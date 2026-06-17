// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MetricBarChart } from "@/app/[locale]/(secure)/app/administrator/_components/metric-bar-chart";

/**
 * Component tests for MetricBarChart (Administrator overview "Insights").
 *
 * Recharts paints an SVG sized by `ResponsiveContainer`, which depends on
 * real layout that jsdom does not provide — and the chart is decorative
 * (`aria-hidden`) regardless. So Recharts is stubbed and the tests pin the
 * part that carries meaning for assistive tech and for callers: the
 * screen-reader data table and the empty state.
 */
vi.mock("recharts", () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrap,
    BarChart: Wrap,
    Bar: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

const DATA = [
  { label: "Jun 11", value: 3 },
  { label: "Jun 12", value: 0 },
  { label: "Jun 13", value: 5 },
];

describe("MetricBarChart", () => {
  it("exposes every datum in an accessible, labelled table", () => {
    render(
      <MetricBarChart
        data={DATA}
        caption="Daily registrations"
        categoryHeader="Day"
        valueHeader="Count"
        emptyLabel="No data"
      />,
    );

    const table = screen.getByRole("table", { name: "Daily registrations" });
    expect(within(table).getByRole("columnheader", { name: "Day" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Count" })).toBeInTheDocument();

    // One header row + one row per datum (including the zero day).
    expect(within(table).getAllByRole("row")).toHaveLength(DATA.length + 1);
    expect(within(table).getByRole("rowheader", { name: "Jun 13" })).toBeInTheDocument();
    expect(within(table).getByText("5")).toBeInTheDocument();
    expect(within(table).getByText("0")).toBeInTheDocument();
  });

  it("renders the empty label and no table when there is no data", () => {
    render(
      <MetricBarChart
        data={[]}
        caption="Daily logins"
        categoryHeader="Day"
        valueHeader="Count"
        emptyLabel="Not enough data to chart yet."
      />,
    );

    expect(screen.getByText("Not enough data to chart yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
