// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid } from "@/app/[locale]/(secure)/app/administrator/_components/grid/data-grid";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the shared `DataGrid` (docs/admin-manager.md §7).
 * Pins the loading / empty / error / data states and the URL-driven
 * pagination behavior. The grid is the foundation under every
 * Administrator list view, so a regression here ripples everywhere.
 */
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/users",
  useSearchParams: () => new URLSearchParams(""),
}));

interface Row {
  id: string;
  name: string;
}

const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: "name", accessorKey: "name", header: () => "Name" },
];

const fetchMock = vi.fn();

beforeEach(() => {
  replaceMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DataGrid", () => {
  it("shows the loading skeleton while the first request is in flight", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders the empty state when total = 0", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0 }),
    });
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    expect(
      await screen.findByText("No results match the current filters."),
    ).toBeInTheDocument();
  });

  it("renders fetched rows in a table", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: "u1", name: "Ada" },
          { id: "u2", name: "Grace" },
        ],
        total: 2,
      }),
    });
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    // Pagination summary is rendered when there are rows.
    expect(screen.getByText(/2 rows/)).toBeInTheDocument();
  });

  it("shows the error state with a retry button when the fetch fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    expect(await screen.findByText("Failed to load. Try again.")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeInTheDocument();
  });

  it("re-issues the request when retry is clicked", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ id: "u1", name: "Ada" }], total: 1 }),
      });
    const user = userEvent.setup();
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    await screen.findByText("Failed to load. Try again.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());
  });

  it("disables the previous-page button on page 1", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "u1", name: "Ada" }], total: 100 }),
    });
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    await screen.findByText("Ada");
    const prev = screen.getByRole("button", { name: "Previous page" });
    expect(prev).toBeDisabled();
  });
});
