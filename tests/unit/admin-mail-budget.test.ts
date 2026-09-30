import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type * as MailBudgetModule from "@/lib/admin/admin-mail-budget.server";
import type * as SharedModule from "@/lib/http/rate-limit-shared.server";

/**
 * F-64 — the budgets on the mail an administrator sends
 * (src/lib/admin/admin-mail-budget.server.ts), without a database: who is held
 * to the org's daily budget, the statement that counts it (compiled by the real
 * Postgres compiler over a scripted driver), the 429 and its `Retry-After`, and
 * the per-recipient cooldown's key and attribution. The count and the cooldown
 * against live Postgres are in tests/db/admin-mail-budget.db.test.ts; that the
 * four routes ask them, in tests/integration/administrator-{email,invitations,
 * user-actions}.test.ts.
 */
const script = vi.hoisted(() => ({
  row: { sent: 0, retry_after: null } as { sent: number; retry_after: number | null },
  calls: [] as { sql: string; parameters: readonly unknown[] }[],
}));
const consumeShared = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());

vi.mock("@/db/database", () => {
  class ScriptedDriver implements Driver {
    async init() {}
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
          script.calls.push({ sql: compiled.sql, parameters: compiled.parameters });
          return { rows: [script.row as R] };
        },
        async *streamQuery(): AsyncIterableIterator<never> {
          throw new Error("not used");
        },
      };
    }
    async beginTransaction() {}
    async commitTransaction() {}
    async rollbackTransaction() {}
    async releaseConnection() {}
    async destroy() {}
  }
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db };
});
vi.mock("@/lib/http/rate-limit-shared.server", () => ({
  consumeSharedToken: (...a: unknown[]) => consumeShared(...a),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditMock(...a),
}));

const ORG = "11111111-2222-4333-8444-555555555555";

const orgAdmin = {
  access: { permissions: ["admin.orgs.manage"], organizationId: ORG },
  betterAuthUserId: "ba-admin",
  requestId: "req-1",
};
const superadmin = {
  access: { permissions: ["superuser"], organizationId: ORG },
  betterAuthUserId: "ba-super",
  requestId: "req-2",
};
const request = () => ({ headers: new Headers() });

let mod: typeof MailBudgetModule;

beforeEach(async () => {
  script.row = { sent: 0, retry_after: null };
  script.calls = [];
  consumeShared.mockReset();
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  vi.resetModules();
  mod = await import("@/lib/admin/admin-mail-budget.server");
  (await import("@/lib/http/rate-limit.server")).__resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

describe("enforceOrgAdminMailBudget", () => {
  it("does not count an org-less (platform) send, nor a caller with cross-org reach", async () => {
    expect(await mod.enforceOrgAdminMailBudget(orgAdmin, null, request())).toBeNull();
    expect(await mod.enforceOrgAdminMailBudget(superadmin, ORG, request())).toBeNull();
    expect(script.calls).toHaveLength(0);
  });

  it("holds a superadmin's ORG-BOUND credential to its org's budget (MACHINE-2)", async () => {
    const bound = { ...superadmin, access: { ...superadmin.access, orgBound: true } };
    script.row = { sent: 200, retry_after: 60 };
    const res = await mod.enforceOrgAdminMailBudget(bound, ORG, request());
    expect(res?.status).toBe(429);
  });

  it("counts only this org's mail-sending admin events in the last 24 hours, newest 200 at most", async () => {
    script.row = { sent: 3, retry_after: 100 };
    expect(await mod.enforceOrgAdminMailBudget(orgAdmin, ORG, request())).toBeNull();
    expect(script.calls).toHaveLength(1);
    const { sql, parameters } = script.calls[0]!;
    expect(sql).toMatch(/from "app_audit_events"/);
    expect(sql).toMatch(/"organization_id" = \$1/);
    expect(sql).toMatch(/"event_type" in \(\$2, \$3, \$4, \$5\)/);
    expect(sql).toContain("created_at > now() - interval '24 hours'");
    expect(sql).toMatch(/order by "created_at" desc limit \$6/);
    expect(parameters).toEqual([
      ORG,
      "admin.email.test_sent",
      "admin.organization.invitation_created",
      "admin.organization.invitation_resent",
      "admin.user.password_reset_email_sent",
      mod.ORG_ADMIN_MAIL_DAILY_LIMIT,
    ]);
  });

  it("admits the last mail under the limit", async () => {
    script.row = { sent: mod.ORG_ADMIN_MAIL_DAILY_LIMIT - 1, retry_after: 100 };
    expect(await mod.enforceOrgAdminMailBudget(orgAdmin, ORG, request())).toBeNull();
  });

  it("refuses at the limit with Retry-After until the oldest counted mail leaves the window", async () => {
    script.row = { sent: mod.ORG_ADMIN_MAIL_DAILY_LIMIT, retry_after: 5400 };
    const res = await mod.enforceOrgAdminMailBudget(orgAdmin, ORG, request());
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("5400");
    expect(await res?.json()).toMatchObject({ error: "rate_limited", retryAfter: 5400 });
    // The denial is counted and sampled into the audit log like any other 429.
    await vi.waitFor(() =>
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "administrator.rate_limited",
          outcome: "denied",
          actorBetterAuthUserId: "ba-admin",
          reason: mod.ORG_ADMIN_MAIL_BUDGET_SCOPE,
        }),
      ),
    );
  });

  it("never answers a Retry-After below one second", async () => {
    for (const retry_after of [0, null]) {
      script.row = { sent: mod.ORG_ADMIN_MAIL_DAILY_LIMIT, retry_after };
      const res = await mod.enforceOrgAdminMailBudget(orgAdmin, ORG, request());
      expect(res?.headers.get("Retry-After")).toBe("1");
    }
  });
});

describe("enforceRecipientCooldown", () => {
  it("takes the recipient's token from the SHARED bucket, one per 10 minutes", async () => {
    consumeShared.mockResolvedValue({ ok: true });
    expect(
      await mod.enforceRecipientCooldown(
        "admin.orgs.invitations.resend",
        "inv-1",
        orgAdmin,
        request(),
      ),
    ).toBeNull();
    expect(consumeShared).toHaveBeenCalledWith("admin.orgs.invitations.resend:inv-1", {
      capacity: 1,
      refillPerSec: 1 / 600,
    });
  });

  it("refuses a cooling recipient, charged to the HUMAN caller and never to the recipient (F-07)", async () => {
    consumeShared.mockResolvedValue({ ok: false, retryAfterSeconds: 420 });
    const req = request();
    const { noteSessionImpersonation } = await import("@/lib/impersonation-attribution.server");
    noteSessionImpersonation(req, {
      user: { id: "ba-admin" },
      session: { impersonatedBy: "ba-human" },
    });
    const res = await mod.enforceRecipientCooldown(
      "admin.users.password.reset_email",
      "user-7",
      orgAdmin,
      req,
    );
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("420");
    await vi.waitFor(() =>
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "administrator.rate_limited",
          actorBetterAuthUserId: "ba-human",
          reason: "admin.users.password.reset_email",
          metadata: expect.objectContaining({ actor: "ba-human" }),
        }),
      ),
    );
  });
});

describe("the shared-bucket budgets", () => {
  it("refill within the shared bucket's prune window, so it accepts them", async () => {
    const shared = await vi.importActual<typeof SharedModule>(
      "@/lib/http/rate-limit-shared.server",
    );
    for (const budget of [mod.ADMIN_TEST_EMAIL_LIMIT, mod.ADMIN_MAIL_RECIPIENT_COOLDOWN]) {
      expect((budget.capacity / budget.refillPerSec) * 1000).toBeLessThanOrEqual(
        shared.SHARED_STALE_AFTER_MS,
      );
    }
  });
});
