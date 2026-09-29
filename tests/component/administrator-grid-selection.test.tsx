// @vitest-environment jsdom
import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogManagerProvider } from "@/components/ui/dialog-manager";
import {
  DataGrid,
  type GridColumnDef,
} from "@/app/[locale]/(secure)/app/administrator/_components/grid/data-grid";
import {
  useGridSelection,
  type UseGridSelectionResult,
} from "@/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-selection";
import { AdministratorUsersGrid } from "@/app/[locale]/(secure)/app/administrator/users/_users-grid";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-114: a grid selection belongs to the search and filters it was made under.
 *
 * "Select all matching" used to survive a change to them. An admin who
 * selected every `pending_approval` match and then cleared the filter still
 * had mode "all", so an Approve or Block (neither asks) sent `ids: "*"` with the
 * NEW, empty filter set and reached every user they could see. The selection is
 * now cleared whenever the URL's `q` or `filter[...]` values change; sort and
 * paging change no match, so they keep it. It records the values it was made
 * under, and a bulk request sends those, not the URL's at send time.
 */
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/users",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/components/i18n/locale-link", () => ({
  LocaleLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function selectionAt(search: string) {
  currentSearch = search;
  return renderHook(() => useGridSelection());
}

/** Moves the mocked URL, as `router.replace` would, and re-renders. */
function navigate(rerender: () => void, search: string) {
  currentSearch = search;
  rerender();
}

const EMPTY = { mode: "page", matchingTotal: null, hasSelection: false };

describe("useGridSelection — cleared when the search or filters change (F-114)", () => {
  it("clears 'select all matching' when the filter it was made under is removed", () => {
    const { result, rerender } = selectionAt("filter[status]=pending_approval");
    act(() => result.current.selectAllMatching(40));
    expect(result.current).toMatchObject({ mode: "all", matchingTotal: 40, hasSelection: true });

    navigate(rerender, "");

    expect(result.current).toMatchObject(EMPTY);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it.each([
    ["the search changes", "q=acme", "q=acm"],
    ["the search is cleared", "q=acme&filter[status]=active", "filter[status]=active"],
    ["a filter is added", "q=acme", "q=acme&filter[status]=blocked"],
    ["a filter's value changes", "filter[status]=pending_approval", "filter[status]=active"],
    [
      "a second value is added to a filter",
      "filter[status]=active",
      "filter[status]=active&filter[status]=blocked",
    ],
  ])("clears it when %s", (_label, from, to) => {
    const { result, rerender } = selectionAt(from);
    act(() => result.current.selectAllMatching(40));

    navigate(rerender, to);

    expect(result.current).toMatchObject(EMPTY);
  });

  it("clears ticked rows too, which no longer match what is shown", () => {
    const { result, rerender } = selectionAt("q=acme");
    act(() => result.current.togglePage(["u1", "u2"], true));
    expect(result.current.selectedIds.size).toBe(2);

    navigate(rerender, "q=beta");

    expect(result.current).toMatchObject(EMPTY);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("does not bring the selection back when the old filters return", () => {
    const { result, rerender } = selectionAt("filter[status]=pending_approval");
    act(() => result.current.selectAllMatching(40));

    navigate(rerender, "");
    navigate(rerender, "filter[status]=pending_approval");

    expect(result.current).toMatchObject(EMPTY);
  });

  it.each([
    ["the sort changes", "sort=primary_email.asc&filter[status]=active"],
    ["the page changes", "filter[status]=active&page=2"],
    ["the page size changes", "filter[status]=active&pageSize=50"],
  ])("keeps it when only %s: the same rows match", (_label, to) => {
    const { result, rerender } = selectionAt("filter[status]=active");
    act(() => result.current.selectAllMatching(40));

    navigate(rerender, to);

    expect(result.current).toMatchObject({ mode: "all", matchingTotal: 40, hasSelection: true });
  });

  it("records the search and filters it was made under, and follows them", () => {
    const { result, rerender } = selectionAt(
      "q=acme&filter[status]=active&filter[status]=blocked&sort=primary_email.asc&page=2",
    );
    act(() => result.current.selectAllMatching(40));
    expect(result.current.scope).toEqual({
      q: "acme",
      filters: { status: ["active", "blocked"] },
    });

    navigate(rerender, "filter[status]=pending_approval");

    expect(result.current).toMatchObject(EMPTY);
    expect(result.current.scope).toEqual({ q: "", filters: { status: "pending_approval" } });
  });

  it("a selection made under the new filters is kept", () => {
    const { result, rerender } = selectionAt("");
    navigate(rerender, "filter[status]=blocked");
    act(() => result.current.selectAllMatching(12));
    rerender();

    expect(result.current).toMatchObject({ mode: "all", matchingTotal: 12 });
  });
});

describe("DataGrid — 'Select all matching' through the toolbar (F-114)", () => {
  interface Row {
    id: string;
    name: string;
  }
  const COLUMNS: GridColumnDef<Row>[] = [{ id: "name", accessorKey: "name", header: () => "Name" }];
  const PAGE: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, name: `User ${i}` }));
  const fetchMock = vi.fn();
  let latest: UseGridSelectionResult | null = null;

  function Harness() {
    const selection = useGridSelection();
    latest = selection;
    return (
      <DataGrid<Row>
        name="t"
        endpoint="/api/test"
        columns={COLUMNS}
        selection={{ state: selection, getRowId: (row) => row.id }}
        bulkActions={[{ key: "approve", label: "Approve selected", onSelect: () => {} }]}
      />
    );
  }

  function Page() {
    return (
      <DialogManagerProvider>
        <Harness />
      </DialogManagerProvider>
    );
  }

  beforeEach(() => {
    latest = null;
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ items: PAGE, total: 60 }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records the count the toolbar offered, and a filter change clears the selection", async () => {
    currentSearch = "filter[status]=pending_approval";
    const user = userEvent.setup();
    const view = renderWithIntl(<Page />);
    await screen.findByText("User 0");

    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Select all 60 matching rows" }));

    expect(screen.getByText("All 60 matching rows selected")).toBeInTheDocument();
    expect(latest).toMatchObject({ mode: "all", matchingTotal: 60 });

    // The admin clears the filter (the grid's own control calls router.replace).
    currentSearch = "";
    view.rerender(<Page />);

    expect(screen.queryByText(/matching rows selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Bulk actions" })).toBeDisabled();
    expect(latest).toMatchObject(EMPTY);
    for (const box of screen.getAllByRole("checkbox", { name: "Select row" })) {
      expect(box).not.toBeChecked();
    }
  });
});

/**
 * The race the recorded scope closes, through the real users grid, hook and
 * dialogs. Approve in "select all matching" awaits a confirmation; the search
 * box commits on a timer, so the URL can move on while the dialog is open. The
 * selection is cleared on screen, but the pending handler still holds the one
 * the admin confirmed, and it used to read the filters from the URL only when
 * it sent the request: `ids: "*"` went out with filters the selection was not
 * made under.
 */
describe("AdministratorUsersGrid - a select-all confirmed after the URL moved (F-114)", () => {
  const USERS = Array.from({ length: 25 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    better_auth_user_id: `ba_${i}`,
    primary_email: `user${i}@example.test`,
    display_name: null,
    status: "pending_approval",
    preferred_locale: "en",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    organization_names: null,
  }));
  type Init = { method?: string; body?: string } | undefined;
  const fetchMock = vi.fn(async (_url: string, init?: Init) => ({
    ok: true,
    status: 200,
    json: async () =>
      init?.method === "POST"
        ? { succeeded: 60, failed: 0, attempted: 60 }
        : { items: USERS, total: 60 },
  }));

  /** Moves the URL as the grid's `router.replace` would. */
  function at(search: string) {
    currentSearch = search;
    window.history.replaceState(null, "", `/en/app/administrator/users?${search}`);
  }

  function Page() {
    return (
      <DialogManagerProvider>
        <AdministratorUsersGrid locale="en" />
      </DialogManagerProvider>
    );
  }

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("sends the filters the selection was made under, not the URL's when the admin confirms", async () => {
    at("filter[status]=pending_approval");
    const user = userEvent.setup();
    const view = renderWithIntl(<Page />);
    await screen.findByText("user0@example.test");

    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Select all 60 matching rows" }));
    await user.click(screen.getByRole("button", { name: "Bulk actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Approve selected" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Apply to all 60 users matching the current search");

    // While it is open, the search box commits `q=acme`.
    at("q=acme");
    view.rerender(<Page />);
    expect(screen.queryByText(/matching rows selected/)).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    await waitFor(() => expect(posted()).toHaveLength(1));
    // Before: `filters: { q: "acme" }`, read from the URL after the dialog.
    expect(JSON.parse(posted()[0]![1]!.body!)).toEqual({
      action: "approve",
      ids: "*",
      filters: { status: "pending_approval" },
    });
  });
});
