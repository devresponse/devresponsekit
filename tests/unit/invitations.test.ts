import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "@/lib/api-auth/api-key";
import {
  consumeInvitation,
  createInvitation,
  findValidInvitationByToken,
  INVITATION_TTL_MS,
  regenerateInvitationToken,
  revokeInvitation,
  type InvitationRow,
} from "@/lib/invitations.server";

/**
 * Unit tests for `invitations.server.ts` (0008).
 *
 * Pins the security contract: hash-at-rest tokens (plaintext never
 * persisted), the email-match rule, the guarded single-use consume, the
 * never-elevate-a-blocked-user rule, and the same-org role re-validation.
 * The Kysely layer is stubbed per-table; hashing is real (Web Crypto).
 */

const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

interface Stubs {
  invitationSelect: () => unknown;
  invitationUpdate: () => { numUpdatedRows: bigint };
  membershipSelect: () => unknown;
  roleSelect: () => unknown;
}

let stubs: Stubs;
let insertCalls: Array<{ table: string; values: Record<string, unknown> }>;
let updateCalls: Array<{ table: string; values: Record<string, unknown> }>;

interface Chain {
  values: (v: Record<string, unknown>) => Chain;
  set: (v: Record<string, unknown>) => Chain;
  select: (...a: unknown[]) => Chain;
  innerJoin: (...a: unknown[]) => Chain;
  where: (...a: unknown[]) => Chain;
  returning: (...a: unknown[]) => Chain;
  onConflict: (...a: unknown[]) => Chain;
  executeTakeFirst: () => Promise<unknown>;
  executeTakeFirstOrThrow: () => Promise<unknown>;
  execute: () => Promise<unknown>;
}

function makeChain(opts: {
  table: string;
  first?: () => unknown;
  firstOrThrow?: () => unknown;
  captureInsert?: boolean;
  captureUpdate?: boolean;
}): Chain {
  let captured: Record<string, unknown> = {};
  const chain: Chain = {
    values: (v) => {
      captured = v;
      if (opts.captureInsert) insertCalls.push({ table: opts.table, values: v });
      return chain;
    },
    set: (v) => {
      captured = v;
      return chain;
    },
    select: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    returning: () => chain,
    onConflict: () => chain,
    executeTakeFirst: () => {
      if (opts.captureUpdate) updateCalls.push({ table: opts.table, values: captured });
      return Promise.resolve(opts.first?.());
    },
    executeTakeFirstOrThrow: () => Promise.resolve(opts.firstOrThrow?.()),
    execute: () => {
      if (opts.captureUpdate) updateCalls.push({ table: opts.table, values: captured });
      return Promise.resolve(undefined);
    },
  };
  return chain;
}

vi.mock("@/db/database", () => ({
  db: {
    insertInto: (table: string) => {
      if (table === "app_organization_invitations")
        return makeChain({ table, captureInsert: true, firstOrThrow: () => ({ id: "inv-1" }) });
      if (table === "app_organization_memberships")
        return makeChain({ table, captureInsert: true });
      if (table === "app_user_roles") return makeChain({ table, captureInsert: true });
      throw new Error(`unmocked insertInto: ${table}`);
    },
    selectFrom: (table: string) => {
      if (table.startsWith("app_organization_invitations"))
        return makeChain({ table, first: () => stubs.invitationSelect() });
      if (table === "app_organization_memberships")
        return makeChain({ table, first: () => stubs.membershipSelect() });
      if (table === "app_roles") return makeChain({ table, first: () => stubs.roleSelect() });
      throw new Error(`unmocked selectFrom: ${table}`);
    },
    updateTable: (table: string) => {
      if (table === "app_organization_invitations")
        return makeChain({ table, captureUpdate: true, first: () => stubs.invitationUpdate() });
      if (table === "app_organization_memberships" || table === "app_users")
        return makeChain({ table, captureUpdate: true });
      throw new Error(`unmocked updateTable: ${table}`);
    },
  },
}));

const INVITATION: InvitationRow = {
  id: "inv-1",
  organizationId: "org-1",
  organizationName: "Org One",
  email: "ada@example.com",
  roleId: null,
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};

const ELIGIBLE_USER = { id: "user-1", primaryEmail: "ada@example.com", status: "pending_approval" };

beforeEach(() => {
  auditMock.mockReset();
  insertCalls = [];
  updateCalls = [];
  stubs = {
    invitationSelect: () => undefined,
    invitationUpdate: () => ({ numUpdatedRows: 1n }),
    membershipSelect: () => undefined,
    roleSelect: () => undefined,
  };
});
afterEach(() => vi.resetModules());

describe("createInvitation", () => {
  it("stores only the SHA-256 of the token and normalizes the email", async () => {
    const result = await createInvitation({
      organizationId: "org-1",
      email: "  Ada@Example.COM ",
      invitedByAppUserId: "admin-1",
    });
    const row = insertCalls.find((c) => c.table === "app_organization_invitations")!.values;
    expect(row.email).toBe("ada@example.com");
    expect(row.token_hash).toBe(await hashSecret(result.plaintextToken));
    expect(row.token_hash).not.toContain(result.plaintextToken);
    expect(result.plaintextToken).toHaveLength(32);
    const ttl = (row.expires_at as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(INVITATION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(INVITATION_TTL_MS);
  });
});

describe("findValidInvitationByToken", () => {
  it("maps a live row and returns null for unknown tokens", async () => {
    stubs.invitationSelect = () => ({
      id: "inv-1",
      organization_id: "org-1",
      organization_name: "Org One",
      email: "ada@example.com",
      role_id: null,
      status: "pending",
      expires_at: new Date("2099-01-01T00:00:00Z"),
    });
    const found = await findValidInvitationByToken("token");
    expect(found).toMatchObject({ id: "inv-1", organizationId: "org-1", email: "ada@example.com" });

    stubs.invitationSelect = () => undefined;
    expect(await findValidInvitationByToken("nope")).toBeNull();
  });
});

describe("consumeInvitation", () => {
  it("rejects an email mismatch before touching anything", async () => {
    const result = await consumeInvitation({
      invitation: INVITATION,
      appUser: { ...ELIGIBLE_USER, primaryEmail: "other@example.com" },
      actorBetterAuthUserId: "ba-1",
    });
    expect(result).toEqual({ consumed: false, reason: "email_mismatch" });
    expect(updateCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("never elevates a blocked user (explicit denials win)", async () => {
    const result = await consumeInvitation({
      invitation: INVITATION,
      appUser: { ...ELIGIBLE_USER, status: "blocked" },
      actorBetterAuthUserId: "ba-1",
    });
    expect(result).toEqual({ consumed: false, reason: "user_not_eligible" });
    expect(updateCalls).toEqual([]);
  });

  it("reports already_consumed when the guarded flip loses the race", async () => {
    stubs.invitationUpdate = () => ({ numUpdatedRows: 0n });
    const result = await consumeInvitation({
      invitation: INVITATION,
      appUser: ELIGIBLE_USER,
      actorBetterAuthUserId: "ba-1",
    });
    expect(result).toEqual({ consumed: false, reason: "already_consumed" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("creates an active membership, activates the pending user, and audits", async () => {
    const result = await consumeInvitation({
      invitation: INVITATION,
      appUser: ELIGIBLE_USER,
      actorBetterAuthUserId: "ba-1",
      provider: "email",
    });
    expect(result).toEqual({ consumed: true, roleGranted: false });
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({ organization_id: "org-1", app_user_id: "user-1", status: "active" });
    // Invitation flip + user activation.
    expect(updateCalls.map((c) => c.table)).toEqual(["app_organization_invitations", "app_users"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.invitation_accepted",
        organizationId: "org-1",
        metadata: expect.objectContaining({ invitationId: "inv-1", roleGranted: false }),
      }),
    );
  });

  it("activates an existing pending membership instead of inserting", async () => {
    stubs.membershipSelect = () => ({ id: "m-1", status: "pending_approval" });
    await consumeInvitation({
      invitation: INVITATION,
      appUser: ELIGIBLE_USER,
      actorBetterAuthUserId: "ba-1",
    });
    expect(insertCalls.find((c) => c.table === "app_organization_memberships")).toBeUndefined();
    expect(
      updateCalls.filter((c) => c.table === "app_organization_memberships").map((c) => c.values),
    ).toEqual([expect.objectContaining({ status: "active" })]);
  });

  it("grants a same-org role and records a missing role instead of failing", async () => {
    stubs.roleSelect = () => ({ id: "role-1" });
    const granted = await consumeInvitation({
      invitation: { ...INVITATION, roleId: "role-1" },
      appUser: ELIGIBLE_USER,
      actorBetterAuthUserId: "ba-1",
    });
    expect(granted).toEqual({ consumed: true, roleGranted: true });
    expect(insertCalls.find((c) => c.table === "app_user_roles")?.values).toMatchObject({
      app_user_id: "user-1",
      organization_id: "org-1",
      role_id: "role-1",
    });

    insertCalls = [];
    auditMock.mockReset();
    stubs.roleSelect = () => undefined; // role deleted / re-scoped since the invite
    const degraded = await consumeInvitation({
      invitation: { ...INVITATION, roleId: "role-gone" },
      appUser: ELIGIBLE_USER,
      actorBetterAuthUserId: "ba-1",
    });
    expect(degraded).toEqual({ consumed: true, roleGranted: false });
    expect(insertCalls.find((c) => c.table === "app_user_roles")).toBeUndefined();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ roleMissing: "role-gone" }),
      }),
    );
  });
});

describe("revokeInvitation / regenerateInvitationToken", () => {
  it("revoke returns true only when a pending row was flipped", async () => {
    expect(
      await revokeInvitation({
        invitationId: "inv-1",
        organizationId: "org-1",
        revokedByBetterAuthUserId: "ba-admin",
      }),
    ).toBe(true);
    stubs.invitationUpdate = () => ({ numUpdatedRows: 0n });
    expect(
      await revokeInvitation({
        invitationId: "inv-1",
        organizationId: "org-1",
        revokedByBetterAuthUserId: "ba-admin",
      }),
    ).toBe(false);
  });

  it("regenerate returns a fresh plaintext for pending rows and null otherwise", async () => {
    const rotated = await regenerateInvitationToken({
      invitationId: "inv-1",
      organizationId: "org-1",
    });
    expect(rotated?.plaintextToken).toHaveLength(32);
    const update = updateCalls.find((c) => c.table === "app_organization_invitations")!.values;
    expect(update.token_hash).toBe(await hashSecret(rotated!.plaintextToken));

    stubs.invitationUpdate = () => ({ numUpdatedRows: 0n });
    expect(
      await regenerateInvitationToken({ invitationId: "inv-1", organizationId: "org-1" }),
    ).toBeNull();
  });
});
