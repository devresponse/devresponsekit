// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the "Roles using this permission" panel
 * (docs/admin-manager.md §8.5).
 *
 * Regression: the panel used to send the filter as `filter.permission`
 * (dot syntax), which `parseListQuery` silently drops — the endpoint
 * only understands `filter[permission]` (bracket syntax) — so the sheet
 * listed every visible role instead of only those holding the
 * permission. The fetch mock here mimics the server contract: it applies
 * the filter only when it arrives in bracket form, so a syntax
 * regression surfaces as unfiltered rows.
 */
vi.mock("@/components/i18n/locale-link", () => ({
  LocaleLink: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} className={className}>
      {children}
    </a>
  ),
}));

import { RolesUsingPermissionPanel } from "@/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const PERMISSION = "admin.users.read";

// SheetTitle/SheetDescription are Radix Dialog parts and need an open
// Dialog root, so render the panel the way the permissions grid does.
function renderPanel() {
  return renderWithIntl(
    <Sheet open>
      <SheetContent side="right">
        <RolesUsingPermissionPanel permissionKey={PERMISSION} />
      </SheetContent>
    </Sheet>,
  );
}

const MATCHING_ROLE = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "app.viewer",
  name: "Viewer",
  organization_id: null,
};
const OTHER_ROLE = {
  id: "22222222-2222-4222-8222-222222222222",
  key: "app.editor",
  name: "Editor",
  organization_id: null,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    // Mirror parseListQuery: only the bracket form counts as a filter;
    // anything else behaves like an unfiltered list request.
    const filtered = new URL(String(url)).searchParams.get("filter[permission]") === PERMISSION;
    const items = filtered ? [MATCHING_ROLE] : [MATCHING_ROLE, OTHER_ROLE];
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ items }) });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("RolesUsingPermissionPanel", () => {
  it("requests roles with the bracket-syntax permission filter and lists only matching roles", async () => {
    renderPanel();

    expect(await screen.findByText("Viewer")).toBeInTheDocument();
    // The unrelated role must NOT appear — it only would if the filter
    // were sent in a form the server drops.
    expect(screen.queryByText("Editor")).not.toBeInTheDocument();

    const requested = String(fetchMock.mock.calls[0]![0]);
    // URLSearchParams percent-encodes the brackets; the server decodes them.
    expect(requested).toContain(`filter%5Bpermission%5D=${encodeURIComponent(PERMISSION)}`);
    expect(new URL(requested).searchParams.get("filter[permission]")).toBe(PERMISSION);
  });

  it("shows the empty state when no roles use the permission", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }) });
    renderPanel();

    expect(await screen.findByText("No roles currently use this permission.")).toBeInTheDocument();
  });

  it("shows an error message when the request fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderPanel();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
