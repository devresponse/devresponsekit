import { describe, expect, it } from "vitest";
import { assertMigrationSession } from "@/db/migrations/apply-migration";

/**
 * DEP2: both runners refuse, before they create anything, a session whose
 * search_path does not resolve to DB_SCHEMA and a role that does not own the
 * existing ledger. The verdicts and their wording against a fake session;
 * tests/db/migration-runner-guards.db.test.ts proves both against Postgres,
 * through the runners.
 */

interface Row {
  schema_name: string | null;
  login: string;
  ledger_owner: string | null;
}

function session(row: Row | undefined) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: row ? [row] : [] };
    },
  };
  return { client: client as never, calls };
}

describe("assertMigrationSession (DEP2)", () => {
  it("passes a session in DB_SCHEMA with no ledger yet (a fresh database)", async () => {
    const { client, calls } = session({ schema_name: "auth", login: "owner", ledger_owner: null });
    await expect(assertMigrationSession(client, "auth")).resolves.toBeUndefined();
    // One query, the schema bound as a parameter, never interpolated.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual(["auth"]);
    expect(calls[0]!.text).toContain("current_schema()");
    expect(calls[0]!.text).toContain("to_regclass(format('%I.app_schema_migrations', $1::text))");
  });

  it("passes the ledger's owner", async () => {
    const { client } = session({ schema_name: "auth", login: "owner", ledger_owner: "owner" });
    await expect(assertMigrationSession(client, "auth")).resolves.toBeUndefined();
  });

  it("refuses a search_path that resolves elsewhere, naming both schemas", async () => {
    const { client } = session({ schema_name: "public", login: "owner", ledger_owner: null });
    await expect(assertMigrationSession(client, "auth")).rejects.toThrow(
      "the session's search_path resolves to public, not DB_SCHEMA auth (DB_SEARCH_PATH_VIA_OPTIONS is off, or a role default points elsewhere); nothing was created there.",
    );
  });

  it("refuses a search_path that resolves to no schema at all", async () => {
    const { client } = session({ schema_name: null, login: "owner", ledger_owner: null });
    await expect(assertMigrationSession(client, "auth")).rejects.toThrow(
      "the session's search_path resolves to no existing schema, not DB_SCHEMA auth",
    );
  });

  it("checks the schema first: a wrong search_path is reported even when the owner differs too", async () => {
    const { client } = session({ schema_name: "public", login: "alice", ledger_owner: "owner" });
    await expect(assertMigrationSession(client, "auth")).rejects.toThrow(/search_path resolves/);
  });

  it("refuses a role that does not own the ledger, naming both roles", async () => {
    const { client } = session({ schema_name: "auth", login: "alice", ledger_owner: "owner" });
    await expect(assertMigrationSession(client, "auth")).rejects.toThrow(
      "auth.app_schema_migrations is owned by owner, but this session migrates as alice: what alice creates would get no runtime grants (0005's default privileges are per creating role) and would break the audit trigger's owner rule. Migrate as owner; nothing was changed.",
    );
  });

  it("refuses when the session cannot be read", async () => {
    const { client } = session(undefined);
    await expect(assertMigrationSession(client, "auth")).rejects.toThrow(
      "could not read the migration session's schema and role.",
    );
  });
});
