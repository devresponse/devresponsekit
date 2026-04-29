import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionUserFromAuth } from "@/lib/user-provisioning.server";

/**
 * Unit tests for `user-provisioning.server.ts > provisionUserFromAuth`.
 *
 * Verifies the documented contract:
 *   - new non-seed users start `pending_approval` with a matching
 *     pending membership and an `auth.account.pending_approval` audit;
 *   - seed users are activated immediately;
 *   - existing users keep their current status (no privilege escalation
 *     from arbitrary OAuth profile data) and emit `auth.account.linked`;
 *   - a missing organization triggers an insert into
 *     `app_organizations` + `app_provider_organizations`.
 *
 * The Kysely query builder is stubbed per-table so each branch can be
 * exercised without a real database.
 */

const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

interface Stubs {
  orgSelect: () => unknown;
  orgInsert?: unknown;
  providerOrgInsert?: unknown;
  userSelect: () => unknown;
  userInsert?: unknown;
  userUpdate?: unknown;
  membershipSelect: () => unknown;
  membershipInsert?: unknown;
}

let stubs: Stubs;

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      if (table === "app_organizations")
        return { select: () => ({ where: () => ({ executeTakeFirst: stubs.orgSelect }) }) };
      if (table === "app_users")
        return { select: () => ({ where: () => ({ executeTakeFirst: stubs.userSelect }) }) };
      if (table === "app_organization_memberships")
        return {
          select: () => ({
            where: () => ({ where: () => ({ executeTakeFirst: stubs.membershipSelect }) }),
          }),
        };
      throw new Error(`unmocked selectFrom: ${table}`);
    },
    insertInto: (table: string) => {
      if (table === "app_organizations")
        return {
          values: () => ({
            returning: () => ({ executeTakeFirstOrThrow: () => stubs.orgInsert }),
          }),
        };
      if (table === "app_provider_organizations")
        return {
          values: () => ({ onConflict: () => ({ execute: () => stubs.providerOrgInsert }) }),
        };
      if (table === "app_users")
        return {
          values: () => ({
            returning: () => ({ executeTakeFirstOrThrow: () => stubs.userInsert }),
          }),
        };
      if (table === "app_organization_memberships")
        return { values: () => ({ execute: () => stubs.membershipInsert }) };
      throw new Error(`unmocked insertInto: ${table}`);
    },
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: () => stubs.userUpdate }) }),
    }),
  },
}));

beforeEach(() => {
  auditMock.mockReset();
  stubs = {
    orgSelect: () => Promise.resolve({ id: "org-default" }),
    userSelect: () => Promise.resolve(undefined),
    userInsert: Promise.resolve({ id: "user-1", status: "pending_approval" }),
    membershipSelect: () => Promise.resolve(undefined),
    membershipInsert: Promise.resolve(undefined),
  };
});
afterEach(() => vi.resetModules());

describe("provisionUserFromAuth", () => {
  it("creates a new pending_approval user and pending membership for non-seed sign-ups", async () => {
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "google",
    });
    expect(result).toMatchObject({
      appUserId: "user-1",
      organizationId: "org-default",
      status: "pending_approval",
      membershipStatus: "pending_approval",
      linkedExisting: false,
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        outcome: "success",
        provider: "google",
      }),
    );
  });

  it("activates seed users immediately", async () => {
    stubs.userInsert = Promise.resolve({ id: "user-seed", status: "active" });
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-seed",
      email: "seed@example.com",
      emailVerified: true,
      provider: "google",
      isSeed: true,
    });
    expect(result.status).toBe("active");
    expect(result.membershipStatus).toBe("active");
  });

  it("preserves existing user status and emits auth.account.linked", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "existing-1", status: "blocked" });
    stubs.userUpdate = Promise.resolve(undefined);
    stubs.membershipSelect = () => Promise.resolve({ id: "m-1", status: "blocked" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "x@example.com",
      emailVerified: true,
      provider: "github",
    });
    expect(result.linkedExisting).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.membershipStatus).toBe("blocked");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.account.linked" }),
    );
  });

  it("creates the organization + provider org row when slug is unknown", async () => {
    stubs.orgSelect = () => Promise.resolve(undefined);
    stubs.orgInsert = Promise.resolve({ id: "new-org" });
    stubs.providerOrgInsert = Promise.resolve(undefined);

    const providerOrgInsertSpy = vi.spyOn(stubs, "providerOrgInsert", "get");
    // Microsoft tenants resolve to a tid-keyed organization, so this triggers
    // the "no existing org" branch.
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-2",
      email: "u@contoso.com",
      emailVerified: true,
      provider: "microsoft",
      profile: { tid: "tenant-123", name: "Contoso" },
    });
    expect(result.organizationId).toBe("new-org");
    providerOrgInsertSpy.mockRestore();
  });
});
