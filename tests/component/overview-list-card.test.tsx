// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { OverviewListCard } from "@/app/[locale]/(secure)/app/administrator/_components/overview-list-card";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Presentational contract of the overview activity table: header row,
 * cell rendering, empty state, and the optional view-all link.
 */
const ROWS = [
  { key: "r1", cells: ["Ada", "active"] },
  { key: "r2", cells: ["Linus", "pending"] },
];

describe("OverviewListCard", () => {
  it("renders the title, headers, and one row per entry", () => {
    renderWithIntl(
      <OverviewListCard
        title="Latest registrations"
        headers={["User", "Status"]}
        rows={ROWS}
        emptyLabel="Nothing here yet."
        locale="en"
      />,
    );
    expect(screen.getByText("Latest registrations")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 rows
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Linus")).toBeInTheDocument();
  });

  it("renders the empty state instead of a table when there are no rows", () => {
    renderWithIntl(
      <OverviewListCard
        title="Latest sign-ins"
        headers={["User", "When"]}
        rows={[]}
        emptyLabel="Nothing here yet."
        locale="en"
      />,
    );
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders the view-all link when a destination is given", () => {
    renderWithIntl(
      <OverviewListCard
        title="Latest audit events"
        headers={["Event"]}
        rows={ROWS.map((r) => ({ key: r.key, cells: [r.cells[0]] }))}
        emptyLabel="Nothing here yet."
        viewAllHref="/app/administrator/audit"
        viewAllLabel="View all"
        locale="en"
      />,
    );
    const link = screen.getByRole("link", { name: "View all" });
    expect(link.getAttribute("href")).toContain("/app/administrator/audit");
  });

  it("omits the view-all link when no destination is given", () => {
    renderWithIntl(
      <OverviewListCard
        title="Latest sign-ins"
        headers={["User"]}
        rows={ROWS.map((r) => ({ key: r.key, cells: [r.cells[0]] }))}
        emptyLabel="Nothing here yet."
        locale="en"
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});
