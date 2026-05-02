// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdministratorSidebar } from "@/app/[locale]/(secure)/app/administrator/_components/administrator-sidebar";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the Administrator workspace sidebar.
 *
 * The sidebar is the user-visible representation of the permission
 * catalog — a regression here would show entries to users who can't
 * actually use them. We pin the gating contract for the major
 * permission slices.
 */
describe("AdministratorSidebar", () => {
  it("hides every permission-gated entry when the caller has none", () => {
    renderWithIntl(<AdministratorSidebar locale="en" permissions={[]} />);
    // Overview is ungated — always visible (rendered as a link).
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    // Identity / Access / Tenancy / Apps / Activity items all need at
    // least one admin.* permission and should be hidden.
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Organizations" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Enterprise applications" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it("shows the Users entry when caller has admin.users.read", () => {
    renderWithIntl(<AdministratorSidebar locale="en" permissions={["admin.users.read"]} />);
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    // Other slices remain hidden.
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it("shows roles + permissions entries only when admin.roles.read is granted", () => {
    renderWithIntl(<AdministratorSidebar locale="en" permissions={["admin.roles.read"]} />);
    expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows the audit-log entry only when admin.audit.read is granted", () => {
    renderWithIntl(<AdministratorSidebar locale="en" permissions={["admin.audit.read"]} />);
    expect(screen.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows every group when caller is a platform admin", () => {
    renderWithIntl(
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
    expect(
      screen.getByRole("link", { name: "Enterprise applications" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
  });
});
