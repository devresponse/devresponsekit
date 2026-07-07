// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the "Roles using this permission" panel rendered in
 * the permissions catalog Sheet. The load-bearing assertion is the request
 * URL: the roles endpoint only honours the `filter[permission]=` bracket
 * syntax (parseListQuery silently drops any other shape, e.g. the old
 * `filter.permission=` dot form, which made the sheet list ALL roles).
 */

// SheetTitle/SheetDescription are Radix Dialog primitives that throw outside
// a Dialog root; the panel is normally mounted inside the catalog's Sheet.
// Swap them for plain elements — the sheet chrome isn't under test here.
vi.mock("@/components/ui/sheet", () => ({
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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

const fetchMock = vi.fn();

function jsonOk(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RolesUsingPermissionPanel", () => {
  const ROLE = {
    id: "r1",
    key: "app.viewer",
    name: "Viewer",
    organization_id: "o1",
  };

  it("requests the roles endpoint with the bracket filter syntax and lists the results", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [ROLE] }));
    renderWithIntl(<RolesUsingPermissionPanel permissionKey="admin.users.read" />);

    expect(await screen.findByText("Viewer")).toBeInTheDocument();

    // The endpoint only parses `filter[permission]=`; any other param shape is
    // silently ignored and would return the full unfiltered role list.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requested.pathname).toBe("/api/administrator/roles");
    expect(requested.searchParams.get("filter[permission]")).toBe("admin.users.read");
    expect(requested.searchParams.get("filter.permission")).toBeNull();

    const link = screen.getByRole("link", { name: "View role" });
    expect(link).toHaveAttribute("href", "/app/administrator/roles/r1");
  });

  it("shows the empty state when no roles use the permission", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [] }));
    renderWithIntl(<RolesUsingPermissionPanel permissionKey="admin.users.read" />);

    expect(await screen.findByText(/No roles/i)).toBeInTheDocument();
  });

  it("surfaces an error when the load fails", async () => {
    fetchMock.mockResolvedValue(jsonOk({}, 500));
    renderWithIntl(<RolesUsingPermissionPanel permissionKey="admin.users.read" />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
