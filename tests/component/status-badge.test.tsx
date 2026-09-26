// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { StatusBadge } from "@/components/ui/status-badge";
import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import {
  APP_STATUS_VALUES,
  APP_USER_STATUS_VALUES,
  CREDENTIAL_STATUS_VALUES,
  MEMBERSHIP_STATUS_VALUES,
  ORGANIZATION_STATUSES,
} from "@/lib/status-values";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-116: StatusBadge rendered `label ?? status`, and nine of its thirteen call
 * sites (the Users, Memberships, Organizations, Enterprise apps and
 * Invitations grids, the org and app detail headers, a user's memberships and
 * an org's members) pass no label. Every locale showed the raw enum
 * (`pending_approval`) beside a Status filter that read "Pending approval".
 * The badge now translates the status itself from `common.status.*`.
 */
describe("StatusBadge (F-116)", () => {
  it("translates the status when no label is passed", () => {
    renderWithIntl(<StatusBadge status="pending_approval" />);
    expect(screen.getByText("Pending approval")).toBeInTheDocument();
    expect(screen.queryByText("pending_approval")).toBeNull();
  });

  it("translates in the viewer's locale, matching the grid's Status filter", () => {
    renderWithIntl(<StatusBadge status="pending_approval" />, { locale: "fr", messages: fr });
    expect(
      screen.getByText(fr.administrator.grid.optionLabels.pending_approval),
    ).toBeInTheDocument();
  });

  it("translates the invitation statuses the filter catalog lacked", () => {
    renderWithIntl(
      <>
        <StatusBadge status="accepted" />
        <StatusBadge status="expired" />
      </>,
    );
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("falls back to the raw value for a status with no translation yet", () => {
    renderWithIntl(<StatusBadge status="quarantined" />);
    expect(screen.getByText("quarantined")).toBeInTheDocument();
  });

  it("an explicit label still wins", () => {
    renderWithIntl(<StatusBadge status="active" label="Live" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("renders an empty badge for a missing status", () => {
    const { container } = renderWithIntl(<StatusBadge status={null} />);
    expect(container.textContent).toBe("");
  });
});

/**
 * Completeness guard: every value a status column can hold has a
 * `common.status` entry, so no call site can show a raw enum. The locale
 * parity test carries the keys to the other seven catalogs. Invitation
 * statuses have no TypeScript enum; they are read from their CHECK constraint.
 */
describe("common.status covers every constrained status (F-116)", () => {
  const schema = readFileSync(
    path.resolve(__dirname, "../../src/db/migrations/0001-initial-schema.sql"),
    "utf8",
  );
  const invitationCheck = schema.match(
    /create table if not exists app_organization_invitations \([\s\S]*?check \(status in \(([^)]*)\)\)/,
  );

  it("parses the invitation status CHECK", () => {
    expect(invitationCheck).not.toBeNull();
  });

  const invitationStatuses = [...(invitationCheck?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
    (m) => m[1]!,
  );
  const all = new Set<string>([
    ...ORGANIZATION_STATUSES,
    ...APP_USER_STATUS_VALUES,
    ...MEMBERSHIP_STATUS_VALUES,
    ...APP_STATUS_VALUES,
    ...CREDENTIAL_STATUS_VALUES,
    ...invitationStatuses,
  ]);

  it.each([...all].sort())("%s", (status) => {
    expect(en.common.status).toHaveProperty(status);
  });
});
