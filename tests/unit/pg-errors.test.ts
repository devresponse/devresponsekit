import { describe, expect, it } from "vitest";
import {
  FOREIGN_KEY_VIOLATION,
  isForeignKeyViolation,
  isUniqueViolation,
  UNIQUE_VIOLATION,
  violatedConstraint,
} from "@/db/pg-errors";
import { pgForeignKeyViolation, pgUniqueViolation } from "../helpers/pg-errors";

/**
 * F-132 — a constraint violation is recognised by the SQLSTATE and constraint
 * `pg` reports, never by the message, whose language follows the server's
 * `lc_messages`.
 */
describe("violatedConstraint", () => {
  it("returns the constraint of a pg error with the asked SQLSTATE", () => {
    expect(
      violatedConstraint(pgUniqueViolation("app_organizations_slug_key"), UNIQUE_VIOLATION),
    ).toBe("app_organizations_slug_key");
    expect(
      violatedConstraint(
        pgForeignKeyViolation("app_roles_organization_id_fkey"),
        FOREIGN_KEY_VIOLATION,
      ),
    ).toBe("app_roles_organization_id_fkey");
  });

  it("is null for another SQLSTATE, a missing constraint, or no pg error at all", () => {
    expect(violatedConstraint(pgUniqueViolation("x_key"), FOREIGN_KEY_VIOLATION)).toBeNull();
    expect(
      violatedConstraint(Object.assign(new Error("dup"), { code: "23505" }), UNIQUE_VIOLATION),
    ).toBeNull();
    for (const value of [null, undefined, "23505", 23505, new Error("boom")]) {
      expect(violatedConstraint(value, UNIQUE_VIOLATION)).toBeNull();
    }
  });
});

describe("isUniqueViolation", () => {
  it("matches a 23505 on the named constraint whatever language the message is in", () => {
    expect(
      isUniqueViolation(
        pgUniqueViolation("app_organizations_slug_key"),
        "app_organizations_slug_key",
      ),
    ).toBe(true);
  });

  it("does not match the English text alone: no SQLSTATE, no violation", () => {
    const english = new Error(
      'duplicate key value violates unique constraint "app_organizations_slug_key"',
    );
    expect(isUniqueViolation(english, "app_organizations_slug_key")).toBe(false);
  });

  it("does not match a 23505 on another constraint of the same table", () => {
    expect(
      isUniqueViolation(
        pgUniqueViolation("app_organization_invitations_token_hash_key"),
        "idx_app_org_invitations_pending_unique",
      ),
    ).toBe(false);
  });

  it("does not match a foreign-key violation that names the constraint", () => {
    expect(
      isUniqueViolation(
        pgForeignKeyViolation("app_permissions_key_key"),
        "app_permissions_key_key",
      ),
    ).toBe(false);
  });
});

describe("isForeignKeyViolation", () => {
  it("matches a 23503 on the named constraint whatever language the message is in", () => {
    expect(
      isForeignKeyViolation(
        pgForeignKeyViolation("app_roles_organization_id_fkey"),
        "app_roles_organization_id_fkey",
      ),
    ).toBe(true);
  });

  it("does not match a 23503 on another constraint when one is named", () => {
    expect(
      isForeignKeyViolation(
        pgForeignKeyViolation("app_audit_events_app_user_id_fkey"),
        "app_audit_events_organization_id_fkey",
      ),
    ).toBe(false);
  });

  it("with no constraint named, matches any 23503 (a DELETE of the referenced row)", () => {
    expect(isForeignKeyViolation(pgForeignKeyViolation("app_api_keys_organization_id_fkey"))).toBe(
      true,
    );
    expect(isForeignKeyViolation(pgUniqueViolation("app_organizations_slug_key"))).toBe(false);
    expect(
      isForeignKeyViolation(new Error("update or delete on table violates foreign key constraint")),
    ).toBe(false);
  });
});
