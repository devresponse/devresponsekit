import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { adminMailLocale } from "@/lib/admin/admin-mail-locale.server";

/**
 * F-102 — the language of a mail an administrator action sends
 * (src/lib/admin/admin-mail-locale.server.ts), without a database: the
 * recipient account's `preferred_locale` when that account is in the mail's
 * org (any account for an org-less platform mail), else the locale of the page
 * the admin sent it from (`Referer`), else the admin's own, else the default.
 * The lookup is compiled by the real Postgres compiler over a scripted driver;
 * the same lookup against live Postgres is in
 * tests/db/organization-invitations.db.test.ts, and that the three routes use
 * it, in tests/integration/administrator-{email,invitations}.test.ts.
 */
const script = vi.hoisted(() => ({
  rows: [] as { preferred_locale: string }[],
  calls: [] as { sql: string; parameters: readonly unknown[] }[],
}));

vi.mock("@/db/database", () => {
  class ScriptedDriver implements Driver {
    async init() {}
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
          script.calls.push({ sql: compiled.sql, parameters: compiled.parameters });
          return { rows: script.rows as R[] };
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

/** A request from the console page at `referer`, or from no page at all. */
const from = (referer?: string) => ({
  headers: new Headers(referer === undefined ? {} : { referer }),
});
const ADMIN_PAGE = "https://app.test/ja/app/administrator/organizations/org-1";
/** The org the mail is sent for: its admins read the outbox row. */
const ORG = "org-1";

beforeEach(() => {
  script.rows = [];
  script.calls = [];
});

describe("adminMailLocale (F-102)", () => {
  it("writes to an address whose account is in the mail's org in that account's language", async () => {
    script.rows = [{ preferred_locale: "uk" }];
    expect(
      await adminMailLocale(" Ada@Example.COM ", ORG, from(ADMIN_PAGE), { preferredLocale: "fr" }),
    ).toBe("uk");
    // One lookup, by the address as the invitation routes' member check
    // compares it (trimmed and case-folded on both sides), and only among the
    // accounts with a membership, in any status, in the org whose admins read
    // the outbox row. An account in another org must answer as no account
    // does, or the row would tell them that it exists, and its language.
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.sql).toBe(
      'select "u"."preferred_locale" from "app_users" as "u" where lower(u.primary_email) = $1' +
        ' and exists (select "m"."id" from "app_organization_memberships" as "m"' +
        ' where "m"."app_user_id" = "u"."id" and "m"."organization_id" = $2)',
    );
    expect(script.calls[0]!.parameters).toEqual(["ada@example.com", ORG]);
  });

  it("looks among every account for an org-less mail, which only a cross-org admin reads", async () => {
    script.rows = [{ preferred_locale: "uk" }];
    expect(
      await adminMailLocale("ada@example.com", null, from(ADMIN_PAGE), { preferredLocale: "fr" }),
    ).toBe("uk");
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.sql).toBe(
      'select "u"."preferred_locale" from "app_users" as "u" where lower(u.primary_email) = $1',
    );
    expect(script.calls[0]!.parameters).toEqual(["ada@example.com"]);
  });

  it("writes to an address with no account in the org in the language of the admin's page", async () => {
    expect(
      await adminMailLocale("new@example.com", ORG, from(ADMIN_PAGE), { preferredLocale: "fr" }),
    ).toBe("ja");
  });

  it("skips an account whose stored language is not a supported one", async () => {
    // `preferred_locale` is tolerant on read (docs/configuration.md).
    script.rows = [{ preferred_locale: "klingon" }];
    expect(
      await adminMailLocale("ada@example.com", ORG, from(ADMIN_PAGE), { preferredLocale: "fr" }),
    ).toBe("ja");
  });

  it("uses the admin's own language when the request names no page (a bearer credential)", async () => {
    expect(await adminMailLocale("new@example.com", ORG, from(), { preferredLocale: "pt" })).toBe(
      "pt",
    );
  });

  it.each([
    ["a page with no locale segment", "https://app.test/api/administrator/email/test"],
    ["an unsupported locale segment", "https://app.test/xx/app/dashboard"],
    ["a site root", "https://app.test/"],
    ["a malformed header", "not a url"],
  ])("ignores a Referer that is %s", async (_label, referer) => {
    expect(
      await adminMailLocale("new@example.com", ORG, from(referer), { preferredLocale: "zh" }),
    ).toBe("zh");
  });

  it("falls back to the default locale only when nothing else names a supported one", async () => {
    expect(await adminMailLocale("new@example.com", ORG, from(), { preferredLocale: "xx" })).toBe(
      "en",
    );
  });
});
