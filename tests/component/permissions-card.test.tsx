// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionsCard } from "@/app/[locale]/(secure)/app/account/_components/permissions-card";

/**
 * Component tests for the Account → Overview PermissionsCard. Pins the
 * assertion surface other tests rely on: every permission key is rendered
 * with a `data-permission` hook, sorted, and the empty state shows the
 * provided label instead of a list.
 */
const STRINGS = {
  title: "Permissions",
  description: "Every action you're currently allowed to perform.",
  emptyLabel: "You have no permissions in the active organization.",
};

describe("PermissionsCard", () => {
  it("renders each permission as a sorted, individually-addressable badge", () => {
    render(
      <PermissionsCard
        permissions={["shell.view", "admin.users.read", "admin.audit.read"]}
        {...STRINGS}
      />,
    );

    const list = screen.getByTestId("account-permissions");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      // Sorted by key for a stable, assertable order.
      "admin.audit.read",
      "admin.users.read",
      "shell.view",
    ]);

    // Each key is addressable for targeted assertions.
    expect(list.querySelector('[data-permission="shell.view"]')).not.toBeNull();
    expect(list.querySelector('[data-permission="admin.users.read"]')).not.toBeNull();
  });

  it("shows the empty label and no list when the user has no permissions", () => {
    render(<PermissionsCard permissions={[]} {...STRINGS} />);

    expect(screen.getByText(STRINGS.emptyLabel)).toBeInTheDocument();
    expect(screen.queryByTestId("account-permissions")).not.toBeInTheDocument();
  });
});
