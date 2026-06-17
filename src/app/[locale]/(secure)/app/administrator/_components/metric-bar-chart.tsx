"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * MetricBarChart
 *
 * Presentational bar chart for the Administrator overview "Insights" section.
 * Pure display: it receives an already-localized, already-scoped series and
 * renders it — all data access and RBAC scoping happen server-side in
 * `selectDashboardMetrics` (`src/lib/admin/dashboard-metrics.server.ts`).
 *
 * Accessibility: the SVG chart is decorative (`aria-hidden`) because Recharts'
 * output is not meaningfully navigable by assistive tech. The same data is
 * exposed as a visually-hidden `<table>` so screen-reader users get the exact
 * figures and the chart adds no axe violations. Counts are integers, so the
 * axis and table never show fractions.
 */
export interface MetricBarDatum {
  /** X-axis category — a localized day label or an organization name. */
  label: string;
  value: number;
}

export interface MetricBarChartProps {
  data: MetricBarDatum[];
  /** Accessible caption for the data table, e.g. "Daily registrations". */
  caption: string;
  /** Header for the category column, e.g. "Day" or "Organization". */
  categoryHeader: string;
  /** Header for the value column, e.g. "Count". */
  valueHeader: string;
  /** Shown instead of a chart when there is nothing to plot. */
  emptyLabel: string;
  /** Bar fill — a CSS color, typically a `var(--chart-N)` token. */
  fill?: string;
}

export function MetricBarChart({
  data,
  caption,
  categoryHeader,
  valueHeader,
  emptyLabel,
  fill = "var(--chart-1)",
}: MetricBarChartProps) {
  if (data.length === 0) {
    return (
      <p className="text-muted-foreground flex h-56 items-center justify-center text-sm">
        {emptyLabel}
      </p>
    );
  }

  return (
    <figure className="m-0">
      <div aria-hidden="true" className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval={0}
            />
            <YAxis
              allowDecimals={false}
              width={36}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--accent)", opacity: 0.4 }}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                color: "var(--popover-foreground)",
              }}
            />
            <Bar dataKey="value" fill={fill} radius={[4, 4, 0, 0]} maxBarSize={48} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{categoryHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
