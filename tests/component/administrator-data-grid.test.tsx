// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
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

/**
 * The current URL query string, read by the mocked `useSearchParams` at
 * render time. The grid takes page / sort / filter state from the URL
 * (docs/admin-manager.md §10), so a test that needs a column to be sorted
 * sets this rather than clicking through the UI.
 */
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/users",
  useSearchParams: () => new URLSearchParams(currentSearch),
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
  currentSearch = "";
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
    expect(await screen.findByText("No results match the current filters.")).toBeInTheDocument();
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

/**
 * A11Y-4 — the sortable column-header button must be NAMED AFTER ITS COLUMN.
 *
 * The regression this pins: `DataGridColumnHeader` built an `aria-label` from
 * `children` but only `if (typeof children === "string")`. `DataGrid` passes
 * `flexRender(columnDef.header, ctx)`, and flexRender wraps a FUNCTION header in
 * `React.createElement` — and every one of the ~100 admin columns declares
 * `header: () => t("…")`. So the string branch was never taken, every sort button
 * on every Administrator grid was labelled "— Not sorted", and because aria-label
 * overrides name-from-content the column name was gone from the accessible name
 * entirely. axe stayed green: the name was non-empty, just identical and useless.
 *
 * The fix makes the name come from the VISIBLE label, so these cases deliberately
 * cover all three header shapes TanStack allows — function-returning-string (what
 * every real grid uses), plain string, and an element with a decorative icon —
 * because the old bug was precisely that only one shape worked.
 */
describe("DataGrid sortable column headers (A11Y-4)", () => {
  interface A11yRow {
    id: string;
    email: string;
    name: string;
    status: string;
  }

  const A11Y_COLUMNS: ColumnDef<A11yRow, unknown>[] = [
    // The shape EVERY production admin column uses.
    { id: "email", accessorKey: "email", header: () => "Email" },
    // TanStack also allows a bare string header.
    { id: "name", accessorKey: "name", header: "Name" },
    // …and an arbitrary element. The icon is decorative; the text is the name.
    {
      id: "status",
      accessorKey: "status",
      header: () => (
        <span>
          <span aria-hidden>★</span>
          Status
        </span>
      ),
    },
    // Not sortable (no accessorKey): rendered raw, contributes no button.
    { id: "__actions", header: () => "", enableSorting: false, cell: () => null },
  ];

  const ROW: A11yRow = { id: "u1", email: "ada@example.com", name: "Ada", status: "active" };

  async function renderGrid(search = ""): Promise<void> {
    currentSearch = search;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [ROW], total: 1 }) });
    renderWithIntl(<DataGrid<A11yRow> name="t" endpoint="/api/test" columns={A11Y_COLUMNS} />);
    await screen.findByText("Ada");
  }

  it("names each sort button after its column, for every header shape", async () => {
    await renderGrid();
    // Exact names — a substring match would still pass if the sort state leaked
    // back into the name, which is the whole defect being pinned here.
    expect(screen.getByRole("button", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
  });

  it("does not render a sort button for a non-sortable column", async () => {
    await renderGrid();
    const headers = screen.getAllByRole("columnheader");
    const actions = headers.at(-1);
    expect(actions).toBeDefined();
    expect(within(actions!).queryByRole("button")).toBeNull();
  });

  it.each([
    ["", "Not sorted", "none"],
    ["sort=email.asc", "Sorted ascending", "ascending"],
    ["sort=email.desc", "Sorted descending", "descending"],
  ])(
    "with %s the Email header keeps its name and describes the sort state",
    async (search, description, ariaSort) => {
      await renderGrid(search);

      // The NAME never changes with the sort state — that is what lets a voice
      // control user say "click Email" in any state (WCAG 2.5.3).
      const button = screen.getByRole("button", { name: "Email" });
      // …and the state rides the description instead.
      expect(button).toHaveAccessibleDescription(description);

      // Channel 2: `aria-sort` on the wrapping columnheader (the ARIA-designated
      // mechanism; the attribute is not valid on role=button).
      const header = screen.getByRole("columnheader", { name: "Email" });
      expect(header).toHaveAttribute("aria-sort", ariaSort);
    },
  );

  it("keeps the sort state out of the column header cell's name", async () => {
    // Screen readers prefix the columnheader's name onto every data cell in the
    // column, so leaking "Not sorted" into it would make each of the N rows
    // announce it. The sr-only state span is `aria-hidden` precisely to stop that
    // while `aria-describedby` still picks it up for the button.
    await renderGrid("sort=email.asc");
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Sorted ascending/ })).toBeNull();
  });

  it("gives every rendered header button a resolvable accessible name", async () => {
    // The completeness guard for THIS grid: whatever columns a caller passes, no
    // header button may end up nameless. The cross-grid counterpart — every
    // sortable column definition in every Administrator grid declaring a header
    // that resolves to a label — is enforced statically in
    // tests/unit/admin-grid-column-label-invariant.test.ts.
    await renderGrid();
    const buttons = screen
      .getAllByRole("columnheader")
      .flatMap((header) => within(header).queryAllByRole("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(
        button,
        `header button ${button.outerHTML} has no accessible name`,
      ).toHaveAccessibleName();
    }
  });
});

describe("DataGrid search & filters", () => {
  const STATUS_FILTER = [
    {
      name: "status",
      label: "Status",
      options: [
        { value: "active", label: "Active" },
        { value: "blocked", label: "Blocked" },
      ],
    },
  ];

  it("does not render the filter bar when neither searchable nor filters are set", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} />);
    await screen.findByText("No results match the current filters.");
    expect(screen.queryByTestId("datagrid-filterbar")).not.toBeInTheDocument();
  });

  it("commits a debounced search term to the URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    const user = userEvent.setup();
    renderWithIntl(<DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} searchable />);

    const box = screen.getByRole("searchbox", { name: "Search" });
    await user.type(box, "ada");

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("q=ada")));
  });

  it("renders an allow-listed filter select and commits the chosen value", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    const user = userEvent.setup();
    renderWithIntl(
      <DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} filters={STATUS_FILTER} />,
    );

    const select = screen.getByRole("combobox", { name: "Filter by Status" });
    expect(select).toBeInTheDocument();
    await user.selectOptions(select, "active");

    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    const lastUrl = String(replaceMock.mock.calls.at(-1)?.[0] ?? "");
    expect(decodeURIComponent(lastUrl)).toContain("filter[status]=active");
  });

  it("offers an 'All' option that clears the filter", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    renderWithIntl(
      <DataGrid<Row> name="t" endpoint="/api/test" columns={COLUMNS} filters={STATUS_FILTER} />,
    );
    const select = screen.getByRole("combobox", { name: "Filter by Status" });
    // The leading option is the "All" sentinel; selecting it removes the filter.
    expect(within(select).getByRole("option", { name: "All" })).toBeInTheDocument();
    // Flush the in-flight fetch so its state update is wrapped in act().
    await screen.findByText("No results match the current filters.");
  });
});
