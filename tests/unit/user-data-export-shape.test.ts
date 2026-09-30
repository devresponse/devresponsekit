import { describe, expect, it } from "vitest";
import { erasedEmailFor, isErasedAccount } from "@/lib/admin/erased-user";
import {
  exportCounts,
  exportFilename,
  iso,
  shapeAuditEvent,
  type AuditRowForExport,
  type ExportSubject,
  type UserDataExport,
} from "@/lib/user-data/export-shape";

/**
 * F-151: the pure half of the data-subject export (`export-shape.ts`) and the
 * erased-account rule (`erased-user.ts`). The audit-row rule is the one real
 * decision about WHOSE data a column is, so each case below is one kind of
 * row: the subject's own request, an administrator acting on them, the subject
 * acting on someone else, and a row that names them only by address.
 * tests/db/user-data-export-erasure.db.test.ts runs the same rule over real
 * rows.
 */
const SUBJECT: ExportSubject = {
  appUserId: "u-x",
  betterAuthUserId: "ba-x",
  emails: new Set(["x@example.test", "x.old@example.test"]),
};

function row(overrides: Partial<AuditRowForExport>): AuditRowForExport {
  return {
    id: "e-1",
    created_at: new Date("2026-09-01T10:00:00Z"),
    event_type: "event",
    outcome: "success",
    actor_better_auth_user_id: null,
    app_user_id: null,
    organization_id: "o-1",
    target_application_id: null,
    provider: null,
    email: null,
    ip_address: "192.0.2.1",
    user_agent: "UA",
    reason: "why",
    request_id: "req-1",
    metadata: { k: "v" },
    ...overrides,
  };
}

describe("shapeAuditEvent (F-151)", () => {
  it("keeps the request's address on the subject's own request", () => {
    expect(
      shapeAuditEvent(row({ actor_better_auth_user_id: "ba-x", app_user_id: "u-x" }), SUBJECT),
    ).toMatchObject({
      role: "subject",
      actedBySelf: true,
      ipAddress: "192.0.2.1",
      userAgent: "UA",
      reason: "why",
      metadata: { k: "v" },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
  });

  it("drops an administrator's address from a row about the subject", () => {
    expect(
      shapeAuditEvent(
        row({ actor_better_auth_user_id: "ba-admin", app_user_id: "u-x", email: "x@example.test" }),
        SUBJECT,
      ),
    ).toMatchObject({
      role: "subject",
      actedBySelf: false,
      email: "x@example.test",
      ipAddress: null,
      userAgent: null,
    });
  });

  it("keeps only the facts of the subject acting on someone else", () => {
    const shaped = shapeAuditEvent(
      row({ actor_better_auth_user_id: "ba-x", app_user_id: "u-y", email: "y@example.test" }),
      SUBJECT,
    );
    expect(shaped).toMatchObject({
      role: "actor",
      actedBySelf: true,
      email: null,
      reason: null,
      metadata: null,
      ipAddress: "192.0.2.1",
    });
    expect(JSON.stringify(shaped)).not.toContain("y@example.test");
  });

  it("treats a row naming one of the subject's addresses as about them, case-insensitively", () => {
    expect(
      shapeAuditEvent(
        row({ actor_better_auth_user_id: "ba-admin", email: "X.Old@Example.TEST", metadata: null }),
        SUBJECT,
      ),
    ).toMatchObject({
      role: "subject",
      email: "X.Old@Example.TEST",
      metadata: {},
      ipAddress: null,
    });
  });

  it("treats an invitation row naming the subject only in metadata.email as about them", () => {
    // `admin.organization.invitation_created`: no subject id, no email column.
    const metadata = { invitationId: "i-1", email: "X@Example.test", roleId: null };
    expect(
      shapeAuditEvent(row({ actor_better_auth_user_id: "ba-admin", metadata }), SUBJECT),
    ).toMatchObject({
      role: "subject",
      actedBySelf: false,
      email: null,
      reason: "why",
      metadata,
      ipAddress: null,
      userAgent: null,
    });
    // Someone else's invitation, sent by the subject: only the facts.
    const theirs = shapeAuditEvent(
      row({
        actor_better_auth_user_id: "ba-x",
        metadata: { invitationId: "i-2", email: "y@example.test" },
      }),
      SUBJECT,
    );
    expect(theirs).toMatchObject({ role: "actor", metadata: null, ipAddress: "192.0.2.1" });
    expect(JSON.stringify(theirs)).not.toContain("y@example.test");
  });

  it("never names another person's address on a subject row", () => {
    expect(
      shapeAuditEvent(row({ app_user_id: "u-x", email: "someone@else.test" }), SUBJECT).email,
    ).toBeNull();
  });
});

describe("export helpers (F-151)", () => {
  it("iso() renders a Date, an ISO string and null", () => {
    expect(iso(null)).toBeNull();
    expect(iso(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(iso("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
  });

  it("names the file after the account and the day, and counts every section", () => {
    const doc = {
      generatedAt: "2026-09-29T12:00:00.000Z",
      profile: { appUserId: "u-x" },
      memberships: [{}],
      roles: [{}, {}],
      groups: [],
      linkedAccounts: [{}],
      sessions: [{}],
      apiKeys: [],
      oauthClients: [],
      invitations: [{}],
      auditEvents: [{}, {}, {}],
    } as unknown as UserDataExport;
    expect(exportFilename(doc)).toBe("user-data-u-x-20260929.json");
    expect(exportCounts(doc)).toEqual({
      memberships: 1,
      roles: 2,
      groups: 0,
      linkedAccounts: 1,
      sessions: 1,
      apiKeys: 0,
      oauthClients: 0,
      invitations: 1,
      auditEvents: 3,
    });
  });
});

describe("erased accounts (F-151)", () => {
  const ID = "11111111-1111-4111-8111-11111111111A";

  it("derives the pseudonym from the account's own id, lowercased like Postgres uuid::text", () => {
    expect(erasedEmailFor(ID)).toBe("erased+11111111-1111-4111-8111-11111111111a@erased.invalid");
  });

  it("recognises only the account's OWN pseudonym", () => {
    expect(isErasedAccount({ appUserId: ID, primaryEmail: erasedEmailFor(ID) })).toBe(true);
    expect(isErasedAccount({ appUserId: ID, primaryEmail: "x@example.test" })).toBe(false);
    expect(
      isErasedAccount({
        appUserId: ID,
        primaryEmail: erasedEmailFor("22222222-2222-4222-8222-222222222222"),
      }),
    ).toBe(false);
  });
});
