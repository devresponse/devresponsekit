import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { AppDatabase } from "@/db/schema/app-schema";
import type * as Mod from "@/lib/api-auth/issuance-fence.server";

/**
 * F-10 — the issuance fence: the lock protocol that stops a credential being
 * born after its owner's credentials were evicted.
 *
 * The executor is a recording builder, so the cases pin WHICH row each side
 * locks and in WHICH mode (the eviction `FOR NO KEY UPDATE`, an issuance
 * `FOR SHARE`: they conflict with each other and neither blocks a plain
 * foreign-key check), that an issuance re-checks its caller only AFTER the
 * lock, and that the transaction is pinned to READ COMMITTED. That the locks
 * really serialize is proven against Postgres in
 * tests/db/credential-eviction.db.test.ts.
 */
const log = vi.hoisted(() => ({ steps: [] as string[], row: undefined as unknown }));

const isSourceCredentialActive = vi.fn();
vi.mock("@/lib/api-auth/revocation.server", () => ({
  isSourceCredentialActive: (...a: unknown[]) => {
    log.steps.push("source-check");
    return isSourceCredentialActive(...a);
  },
}));

const DEFAULT_DB = vi.hoisted(() => ({ isDefault: true }));
vi.mock("@/db/database", () => ({ db: DEFAULT_DB }));

function recorder(isTransaction = true): Kysely<AppDatabase> {
  const builder: Record<string, unknown> = {
    isTransaction,
    selectFrom: (table: string) => {
      log.steps.push(`from ${table}`);
      return builder;
    },
    select: () => builder,
    where: (column: string, op: string, value: unknown) => {
      log.steps.push(`where ${column} ${op} ${typeof value === "string" ? value : "<sql>"}`);
      return builder;
    },
    forShare: () => {
      log.steps.push("FOR SHARE");
      return builder;
    },
    forNoKeyUpdate: () => {
      log.steps.push("FOR NO KEY UPDATE");
      return builder;
    },
    executeTakeFirst: async () => log.row,
  };
  return builder as unknown as Kysely<AppDatabase>;
}

let M: typeof Mod;

beforeEach(async () => {
  log.steps = [];
  log.row = { id: "row" };
  isSourceCredentialActive.mockReset().mockResolvedValue(true);
  M = await import("@/lib/api-auth/issuance-fence.server");
});

describe("the two locks", () => {
  it("the eviction locks the owner's app_users row FOR NO KEY UPDATE", async () => {
    await M.lockOwnerForEviction(recorder(), "owner-1");

    expect(log.steps).toEqual(["from app_users", "where id = owner-1", "FOR NO KEY UPDATE"]);
  });

  it("an issuance locks the same row FOR SHARE", async () => {
    await M.lockOwnerForIssuance(recorder(), "owner-1");

    expect(log.steps).toEqual(["from app_users", "where id = owner-1", "FOR SHARE"]);
  });
});

describe("enterIssuanceFence", () => {
  it("takes the lock BEFORE it re-checks the calling credential", async () => {
    const trx = recorder();

    await M.enterIssuanceFence(trx, "owner-1", { kind: "api_key", id: "key-1" });

    expect(log.steps).toEqual([
      "from app_users",
      "where id = owner-1",
      "FOR SHARE",
      "source-check",
    ]);
    // The re-check runs on the fence's own transaction, after the lock.
    expect(isSourceCredentialActive).toHaveBeenCalledWith(
      { kind: "api_key", id: "key-1" },
      expect.any(Date),
      trx,
    );
  });

  it("throws IssuingCredentialRevokedError when the calling credential died", async () => {
    isSourceCredentialActive.mockResolvedValue(false);

    await expect(
      M.enterIssuanceFence(recorder(), "owner-1", { kind: "api_key", id: "key-1" }),
    ).rejects.toBeInstanceOf(M.IssuingCredentialRevokedError);
  });
});

describe("isCallerSourceLive", () => {
  it("a session is live while its row exists and has not expired", async () => {
    const trx = recorder();

    await expect(M.isCallerSourceLive({ kind: "session", sessionId: "sess-1" }, trx)).resolves.toBe(
      true,
    );
    expect(log.steps).toEqual(["from session", "where id = sess-1", "where expiresAt > <sql>"]);

    log.row = undefined;
    await expect(M.isCallerSourceLive({ kind: "session", sessionId: "sess-1" }, trx)).resolves.toBe(
      false,
    );
    expect(isSourceCredentialActive).not.toHaveBeenCalled();
  });

  it("a token is checked against its SOURCE credential and its iat", async () => {
    const trx = recorder();
    const issuedAt = new Date("2026-09-23T10:00:00Z");
    const credential = { kind: "oauth_client" as const, id: "client-1" };
    isSourceCredentialActive.mockResolvedValue(false);

    await expect(M.isCallerSourceLive({ kind: "token", credential, issuedAt }, trx)).resolves.toBe(
      false,
    );
    expect(isSourceCredentialActive).toHaveBeenCalledWith(credential, issuedAt, trx);
  });

  it("defaults to the shared pool", async () => {
    await M.isCallerSourceLive({ kind: "api_key", id: "key-1" });

    expect(isSourceCredentialActive).toHaveBeenCalledWith(
      { kind: "api_key", id: "key-1" },
      expect.any(Date),
      DEFAULT_DB,
    );
  });
});

describe("inIssuanceTransaction", () => {
  it("opens a READ COMMITTED transaction: the re-check must see what committed during the lock wait", async () => {
    const levels: string[] = [];
    const trx = recorder();
    const executor = {
      isTransaction: false,
      transaction: () => {
        const builder = {
          setIsolationLevel: (level: string) => {
            levels.push(level);
            return builder;
          },
          execute: (fn: (t: unknown) => Promise<unknown>) => fn(trx),
        };
        return builder;
      },
    } as unknown as Kysely<AppDatabase>;

    await expect(
      M.inIssuanceTransaction(async (t) => (t === trx ? "ran in trx" : "wrong"), executor),
    ).resolves.toBe("ran in trx");
    expect(levels).toEqual(["read committed"]);
  });

  it("runs inside a caller's transaction instead of nesting one", async () => {
    const trx = recorder(true);

    await expect(M.inIssuanceTransaction(async (t) => t, trx)).resolves.toBe(trx);
  });
});
