// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { BulkActionDescriptor } from "@/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar";
import { MAX_BULK_IDS } from "@/lib/admin/bulk-limits";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Client-side mirror of the bulk endpoint's id cap (review #34).
 *
 * The grid carried a comment claiming it mirrored `MAX_BULK_IDS` while
 * checking nothing: a 501-row selection was POSTed, rejected by the route's
 * Zod schema with a 400, and reported to the operator as the generic "Bulk
 * action failed." — with no hint that the batch was simply too large.
 *
 * The grid itself is not under test here; `DataGrid` is stubbed so the
 * bulk-action callbacks can be invoked directly, and `useGridSelection` is
 * stubbed so a selection larger than the cap can be constructed at all
 * (clicking 501 checkboxes is not a test).
 */
const notify = vi.fn();
const selection = {
  selectedIds: new Set<string>(),
  mode: "page" as "page" | "all",
  hasSelection: true,
  toggle: vi.fn(),
  togglePage: vi.fn(),
  selectAllMatching: vi.fn(),
  clear: vi.fn(),
  count: 0,
};

let capturedActions: BulkActionDescriptor[] = [];

vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ notify, confirm: vi.fn(), promptText: vi.fn() }),
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-selection", () => ({
  useGridSelection: () => selection,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/_components/grid/data-grid", () => ({
  DataGrid: (props: { bulkActions?: BulkActionDescriptor[] }) => {
    capturedActions = props.bulkActions ?? [];
    return null;
  },
}));

const fetchMock = vi.fn();

function ids(n: number): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `11111111-1111-4111-8111-${String(i)}`));
}

async function renderGrid() {
  const { AdministratorUsersGrid } =
    await import("@/app/[locale]/(secure)/app/administrator/users/_users-grid");
  renderWithIntl(<AdministratorUsersGrid locale="en" />);
}

/** Fire the "Approve selected" bulk action the toolbar would surface. */
function approve() {
  const action = capturedActions.find((a) => a.key === "approve")!;
  action.onSelect();
}

beforeEach(() => {
  notify.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ succeeded: 1, failed: 0, attempted: 1 }),
  });
  vi.stubGlobal("fetch", fetchMock);
  selection.mode = "page";
  selection.selectedIds = new Set();
  capturedActions = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("AdministratorUsersGrid — bulk id cap (review #34)", () => {
  it("refuses a selection larger than the server cap and says why", async () => {
    selection.selectedIds = ids(MAX_BULK_IDS + 1);
    await renderGrid();
    approve();

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `Select at most ${MAX_BULK_IDS} users for a bulk action.`,
        variant: "destructive",
      }),
    );
    // The request the server would have rejected is never sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a selection exactly at the cap", async () => {
    selection.selectedIds = ids(MAX_BULK_IDS);
    await renderGrid();
    approve();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/administrator/users/bulk");
    expect((JSON.parse(init.body) as { ids: string[] }).ids).toHaveLength(MAX_BULK_IDS);
  });

  it("does not apply the id cap to 'select all matching' (the server expands it)", async () => {
    selection.mode = "all";
    selection.selectedIds = ids(MAX_BULK_IDS + 1);
    await renderGrid();
    approve();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as { ids: string }).ids).toBe("*");
  });
});
