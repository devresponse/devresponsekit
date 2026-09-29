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
 * The same holds for "select all matching", whose cap the server applies: its
 * `too_many_matches` refusal names the limit too (F-62), and a selection the
 * toolbar already counted past the cap is refused before any dialog. Approve
 * and block confirm there, naming the count, and every action sends the search
 * and filters the selection was made under, not the URL's (F-114).
 *
 * The grid itself is not under test here; `DataGrid` is stubbed so the
 * bulk-action callbacks can be invoked directly, and `useGridSelection` is
 * stubbed so a selection larger than the cap can be constructed at all
 * (clicking 501 checkboxes is not a test).
 */
const notify = vi.fn();
const confirm = vi.fn();
const promptText = vi.fn();
const selection = {
  selectedIds: new Set<string>(),
  mode: "page" as "page" | "all",
  matchingTotal: null as number | null,
  scope: { q: "", filters: {} } as { q: string; filters: Record<string, string | string[]> },
  hasSelection: true,
  toggle: vi.fn(),
  togglePage: vi.fn(),
  selectAllMatching: vi.fn(),
  clear: vi.fn(),
  count: 0,
};

let capturedActions: BulkActionDescriptor[] = [];

vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ notify, confirm, promptText }),
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

/** Fire a bulk action the toolbar would surface ("Approve selected" by default). */
function approve(key = "approve") {
  const action = capturedActions.find((a) => a.key === key)!;
  action.onSelect();
}

beforeEach(() => {
  notify.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(true);
  promptText.mockReset().mockResolvedValue("spam");
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ succeeded: 1, failed: 0, attempted: 1 }),
  });
  vi.stubGlobal("fetch", fetchMock);
  selection.mode = "page";
  selection.selectedIds = new Set();
  selection.matchingTotal = null;
  selection.scope = { q: "", filters: {} };
  capturedActions = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Lets any pending work settle before asserting that nothing was sent. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    // Ticked rows are the admin's own choice: approve does not ask (F-114).
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not apply the id cap to 'select all matching' (the server expands it)", async () => {
    selection.mode = "all";
    selection.matchingTotal = 40;
    selection.selectedIds = ids(MAX_BULK_IDS + 1);
    await renderGrid();
    approve();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as { ids: string }).ids).toBe("*");
  });

  // Ban and soft-delete ask first too; a batch that is refused anyway is
  // refused before the admin types a reason or confirms.
  it.each(["ban", "soft_delete"])(
    "refuses an over-cap selection before %s asks anything",
    async (key) => {
      selection.selectedIds = ids(MAX_BULK_IDS + 1);
      await renderGrid();
      approve(key);

      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Select at most ${MAX_BULK_IDS} users for a bulk action.`,
        }),
      );
      expect(promptText).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // F-62: when the toolbar already counted more matches than one batch may act
  // on, "select all" is refused before any dialog: the server would refuse it
  // after the admin had confirmed.
  it.each(["approve", "block", "ban", "soft_delete"])(
    "refuses a 'select all matching' the toolbar counted past the cap before %s asks anything",
    async (key) => {
      selection.mode = "all";
      selection.matchingTotal = MAX_BULK_IDS + 1;
      await renderGrid();
      approve(key);

      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Select at most ${MAX_BULK_IDS} users for a bulk action.`,
          variant: "destructive",
        }),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(promptText).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // F-62: the server refuses "select all" when more users match than one batch
  // may act on, and applies nothing. That used to read as "Bulk action failed."
  // The toolbar's count can be below the server's (users signed up since).
  it("says how many users a batch may reach when the server refuses too many matches", async () => {
    selection.mode = "all";
    selection.matchingTotal = 40;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "too_many_matches", matched: 1200, max: MAX_BULK_IDS }),
    });
    await renderGrid();
    approve();

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `Select at most ${MAX_BULK_IDS} users for a bulk action.`,
        variant: "destructive",
      }),
    );
  });

  it("any other refusal is still the generic failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_body" }),
    });
    selection.selectedIds = ids(1);
    await renderGrid();
    approve();

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Bulk action failed.", variant: "destructive" }),
    );
  });
});

/**
 * F-114: approve and block run without a dialog, which is fine for the rows an
 * admin ticked. "Select all matching" can reach every user in the search, up to
 * the bulk cap, so there they first ask, naming the count the toolbar offered.
 */
describe("AdministratorUsersGrid — 'select all matching' asks first (F-114)", () => {
  beforeEach(() => {
    selection.mode = "all";
    selection.matchingTotal = 40;
  });

  it.each([
    ["approve", "Approve selected"],
    ["block", "Block selected"],
  ])("%s names the count, and declining sends nothing", async (key, title) => {
    confirm.mockResolvedValue(false);
    await renderGrid();
    approve(key);

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title,
      description:
        "Apply to all 40 users matching the current search and filters? Your own account, if it matches, is skipped.",
    });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["approve", "block"])("%s is sent once confirmed", async (key) => {
    await renderGrid();
    approve(key);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ action: key, ids: "*" });
  });
});

/**
 * F-114: a handler that awaits a dialog resumes with the selection of the
 * render it was clicked in, and the URL can move on while the dialog is open
 * (the search box commits on a timer). The request must carry the search and
 * filters the selection was made under, the ones its count and confirmation
 * came from, not whatever the URL holds when the admin answers.
 */
describe("AdministratorUsersGrid - 'select all matching' sends the filters it was made under (F-114)", () => {
  beforeEach(() => {
    selection.mode = "all";
    selection.matchingTotal = 40;
    selection.scope = { q: "", filters: { status: "pending_approval" } };
    window.history.replaceState(
      null,
      "",
      "/en/app/administrator/users?filter[status]=pending_approval",
    );
    // While the dialog is open, the search box commits `q=acme`.
    const moveUrl = () =>
      window.history.replaceState(null, "", "/en/app/administrator/users?q=acme");
    confirm.mockImplementation(async () => {
      moveUrl();
      return true;
    });
    promptText.mockImplementation(async () => {
      moveUrl();
      return "spam";
    });
  });

  it.each(["approve", "block", "ban", "soft_delete"])("%s", async (key) => {
    await renderGrid();
    approve(key);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    // Before: `filters: { q: "acme" }`, read from the URL after the dialog.
    expect(JSON.parse(init.body)).toMatchObject({ action: key, ids: "*" });
    expect((JSON.parse(init.body) as { filters: object }).filters).toEqual({
      status: "pending_approval",
    });
  });

  it("sends a search and several statuses as they were", async () => {
    selection.scope = { q: "acme", filters: { status: ["active", "blocked"] } };
    await renderGrid();
    approve("block");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as { filters: object }).filters).toEqual({
      status: ["active", "blocked"],
      q: "acme",
    });
  });
});
