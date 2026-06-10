// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as I18nNavigation from "@/i18n/navigation";
import { AdministratorSidebar } from "@/app/[locale]/(secure)/app/administrator/_components/administrator-sidebar";
import { SidebarProvider } from "@/components/ui/flexsidebar";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the Administrator workspace sidebar.
 *
 * The sidebar is the user-visible representation of the permission
 * catalog — a regression here would show entries to users who can't
 * actually use them. We pin the gating contract for the major
 * permission slices, plus the FlexSidebar presentation contract
 * (icons, active item, in-flow layout).
 */

// AdministratorSidebar derives the active item from the locale-less pathname.
vi.mock("@/i18n/navigation", async () => {
  const actual = await vi.importActual<typeof I18nNavigation>("@/i18n/navigation");
  return {
    ...actual,
    usePathname: () => "/app/administrator/users",
  };
});

/** AdministratorSidebar requires the provider mounted by the admin layout. */
function renderSidebar(ui: React.ReactElement) {
  return renderWithIntl(<SidebarProvider>{ui}</SidebarProvider>);
}

describe("AdministratorSidebar", () => {
  it("hides every permission-gated entry when the caller has none", () => {
    renderSidebar(<AdministratorSidebar locale="en" permissions={[]} />);
    // Overview is ungated — always visible (rendered as a link).
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    // Identity / Access / Tenancy / Apps / Activity items all need at
    // least one admin.* permission and should be hidden.
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Organizations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enterprise applications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it("shows the Users entry when caller has admin.users.read", () => {
    renderSidebar(<AdministratorSidebar locale="en" permissions={["admin.users.read"]} />);
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    // Other slices remain hidden.
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it("shows roles + permissions entries only when admin.roles.read is granted", () => {
    renderSidebar(<AdministratorSidebar locale="en" permissions={["admin.roles.read"]} />);
    expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows the audit-log entry only when admin.audit.read is granted", () => {
    renderSidebar(<AdministratorSidebar locale="en" permissions={["admin.audit.read"]} />);
    expect(screen.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows every group when caller is a platform admin", () => {
    renderSidebar(
      <AdministratorSidebar
        locale="en"
        permissions={[
          "admin.users.read",
          "admin.roles.read",
          "admin.orgs.read",
          "admin.apps.read",
          "admin.audit.read",
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organizations" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Memberships" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enterprise applications" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
  });

  it("renders icons aria-hidden, marks the pathname item active, stays in-flow", () => {
    const { container } = renderSidebar(
      <AdministratorSidebar locale="en" permissions={["admin.users.read", "admin.roles.read"]} />,
    );

    // Every entry carries an allow-listed icon; decorative only.
    const users = screen.getByRole("link", { name: "Users" });
    expect(users.querySelector("svg")).not.toBeNull();
    expect(users.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    // Active item from the mocked pathname (/app/administrator/users).
    expect(users.getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Roles" }).getAttribute("data-active")).toBe("false");

    // FlexSidebar contract: no fixed positioning / viewport-height classes.
    const offenders = [...container.querySelectorAll("[class]")].filter((el) => {
      const cls = el.getAttribute("class") ?? "";
      return /\bfixed\b/.test(cls) || /\bh-svh\b/.test(cls) || /\bmin-h-svh\b/.test(cls);
    });
    expect(offenders).toEqual([]);
  });
});
