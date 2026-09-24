import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";
import type { KeysetCursor } from "@/lib/admin/list-query.server";

/**
 * DB-BACKED test for F-31: the CSV export's keyset walk must emit every row
 * exactly once, even when many rows share one `timestamptz` instant.
 *
 * The export pages 1,000 rows at a time and seeks each page past the previous
 * page's last row on `(…sort, id)`. The cursor used to be read off the row as
 * `pg` typed it, and `pg` turns a `timestamptz` into a JS `Date`, which keeps
 * MILLISECONDS; Postgres stores microseconds. A last row at `.500250` made a
 * cursor of `.500`, so the next page's `created_at < '.500'` (desc) skipped
 * every remaining row of that instant and `created_at > '.500'` (asc)
 * re-selected them. With a page's worth of rows in one millisecond — any bulk
 * transaction, whose rows all share `now()` — the ascending export repeated
 * the same page until the row cap and the descending one silently dropped the
 * rest. The unit suite can only compile SQL; the truncation happens in the
 * driver, so only a real round trip through Postgres shows it.
 *
 * Fixtures: more than a page of rows sharing one instant (a transaction's
 * `now()`, and a fixed instant 250 µs past a millisecond so the result never
 * depends on where `now()` lands), plus 950 rows at DISTINCT microseconds
 * inside one millisecond. The real `GET` handler runs against them with only
 * auth and the rate limiter stubbed, and every export is compared, row for
 * row and in order, with one ordered query over the same rows. All fixture
 * rows carry the `__dbtest_keyset_` prefix; audit rows (append-only) are
 * removed through the sanctioned retention GUC.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
// The export budget is 3 per actor per minute; this file runs a dozen exports.
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

/** The route's page size (`PAGE_SIZE` in the export route). */
const PAGE_SIZE = 1_000;
/**
 * `MAX_EXPORT_ROWS` is read when the route module loads. Well above every
 * fixture here, but low enough that the pre-fix ascending loop (the same page
 * over and over) reaches it in seconds instead of 100 pages.
 */
const EXPORT_CAP = 10_000;
const previousCap = process.env.ADMIN_EXPORT_MAX_ROWS;
process.env.ADMIN_EXPORT_MAX_ROWS = String(EXPORT_CAP);

const { db, pgPool } = await import("@/db/database");
const { GET } = await import("@/app/api/administrator/export/[resource]/route");
const { applyKeyset, buildKeysetSort, keysetCursorFrom } =
  await import("@/lib/admin/list-query.server");

const PREFIX = "__dbtest_keyset_";
/** The exporting admin: its `admin.export.*` audit rows are cleaned up too. */
const ACTOR = `${PREFIX}admin`;
/** Every fixture audit row's actor, so one filter selects exactly them. */
const FIXTURE_ACTOR = `${PREFIX}fixture`;
const BULK_NOW = `${PREFIX}bulk_now`;
const BULK_FIXED = `${PREFIX}bulk_fixed`;
const MICRO = `${PREFIX}micro`;
/** 250 µs past a millisecond: a millisecond cursor can never equal it. */
const FIXED_INSTANT = "2020-01-01T00:00:00.500250Z";
/** 950 rows at .700000 … .700949 — distinct microseconds, one millisecond. */
const MICRO_BASE = "2020-01-01T00:00:00.700000Z";
const MICRO_ROWS = 950;
/**
 * A hostile display name for the users export's nullable text sort: the
 * cursor now travels as JSON text, so quoting, escapes, braces, the word NULL
 * and non-ASCII must all survive the round trip. No newline: the CSV reader
 * below splits on lines.
 */
const HOSTILE_NAME = 'Ωmega "quoted", {braces} \\back\\slash NULL =1+1 ';

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-keyset-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.audit.read", "admin.users.read", "admin.apps.read", "superuser"],
};

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "in", [ACTOR, FIXTURE_ACTOR])
      .execute();
  });
  await db
    .deleteFrom("app_users")
    .where(sql<boolean>`starts_with(better_auth_user_id, ${PREFIX})`)
    .execute();
  await db
    .deleteFrom("app_enterprise_applications")
    .where(sql<boolean>`starts_with(id, ${PREFIX})`)
    .execute();
}

async function seed(): Promise<void> {
  // A bulk action: one transaction, so every row shares its `now()` — across
  // statements, not only within one.
  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < 2; i += 1) {
      await sql`
        insert into app_audit_events (event_type, outcome, actor_better_auth_user_id)
        select ${BULK_NOW}, 'success', ${FIXTURE_ACTOR} from generate_series(1, 600)
      `.execute(trx);
    }
  });
  await sql`
    insert into app_audit_events (event_type, outcome, actor_better_auth_user_id, created_at)
    select ${BULK_FIXED}, 'success', ${FIXTURE_ACTOR}, ${FIXED_INSTANT}::timestamptz
    from generate_series(1, 1100)
  `.execute(db);
  await sql`
    insert into app_audit_events (event_type, outcome, actor_better_auth_user_id, created_at)
    select ${MICRO}, 'success', ${FIXTURE_ACTOR},
           ${MICRO_BASE}::timestamptz + g * interval '1 microsecond'
    from generate_series(0, ${MICRO_ROWS - 1}) g
  `.execute(db);

  // 2,100 users from one transaction, pinned 321 µs past its `now()`'s
  // millisecond (a bare `now()` is millisecond-aligned one time in a
  // thousand, and then the pre-fix code would pass by luck). 1,100 carry the
  // hostile name, 1,000 have none: sorted by name, one page boundary falls
  // inside the named run and the next inside the NULL block.
  await sql`
    insert into app_users (better_auth_user_id, primary_email, display_name, status, created_at)
    select ${PREFIX} || 'u' || g,
           ${PREFIX} || 'u' || g || '@dbtest.local',
           case when g <= 1100 then ${HOSTILE_NAME} end,
           'active',
           date_trunc('milliseconds', now()) + interval '321 microseconds'
    from generate_series(1, 2100) g
  `.execute(db);

  // The review's missing sibling: enterprise apps, sortable by created_at,
  // with a TEXT id tiebreaker and an integer default sort (sort_order) whose
  // three values each span hundreds of rows.
  await sql`
    insert into app_enterprise_applications
      (id, label, origin, subdomain, sso_audience, sort_order, created_at)
    select ${PREFIX} || 'app_' || g,
           'DBTest app ' || g,
           'https://dbtest.local',
           'dbtest' || g,
           ${PREFIX} || 'aud_' || g,
           g % 3,
           date_trunc('milliseconds', now()) + interval '654 microseconds'
    from generate_series(1, 1100) g
  `.execute(db);
}

beforeAll(async () => {
  await cleanup();
  await seed();
});

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
  if (previousCap === undefined) delete process.env.ADMIN_EXPORT_MAX_ROWS;
  else process.env.ADMIN_EXPORT_MAX_ROWS = previousCap;
});

interface ExportResult {
  /** The first CSV column (`id`) of every data row, in stream order. */
  ids: string[];
  /** `# export_truncated:` / `# export_failed:` lines. */
  sentinels: string[];
}

async function runExport(
  resource: string,
  params: Record<string, string | readonly string[]>,
): Promise<ExportResult> {
  const url = new URL(`http://test.local/api/administrator/export/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    for (const v of typeof value === "string" ? [value] : value) url.searchParams.append(key, v);
  }
  const request = {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
  const res = await GET(request, { params: Promise.resolve({ resource }) });
  const body = await res.text();
  expect(res.status, body.slice(0, 500)).toBe(200);
  const [header, ...lines] = body.split("\n").filter((line) => line !== "");
  expect(header).toMatch(/^id,/);
  return {
    ids: lines.filter((l) => !l.startsWith("# ")).map((l) => l.slice(0, l.indexOf(","))),
    sentinels: lines.filter((l) => l.startsWith("# ")),
  };
}

/**
 * Every row once, in the query's order, and the walk ended on its own. The
 * summary comes first so a failure reads as "2000 of 3250, 0 duplicates"
 * rather than as a diff of thousands of ids.
 */
function expectExactly(actual: ExportResult, expected: string[]): void {
  expect({
    rows: actual.ids.length,
    distinct: new Set(actual.ids).size,
    sentinels: actual.sentinels,
  }).toEqual({ rows: expected.length, distinct: expected.length, sentinels: [] });
  expect(actual.ids).toEqual(expected);
}

async function auditIds(direction: "asc" | "desc"): Promise<string[]> {
  const rows = await db
    .selectFrom("app_audit_events")
    .select("id")
    .where("actor_better_auth_user_id", "=", FIXTURE_ACTOR)
    .orderBy("created_at", direction)
    .orderBy("id", "asc")
    .execute();
  return rows.map((r) => r.id);
}

describe("F-31 fixture shape", () => {
  it("more than a page shares one instant, and one millisecond holds 950 distinct instants", async () => {
    const { rows } = await sql<{
      event_type: string;
      n: number;
      instants: number;
      millis: number;
    }>`
      select event_type,
             count(*)::int as n,
             count(distinct created_at)::int as instants,
             count(distinct date_trunc('milliseconds', created_at))::int as millis
      from app_audit_events
      where actor_better_auth_user_id = ${FIXTURE_ACTOR}
      group by event_type
      order by event_type
    `.execute(db);
    expect(rows).toEqual([
      { event_type: BULK_FIXED, n: 1100, instants: 1, millis: 1 },
      { event_type: BULK_NOW, n: 1200, instants: 1, millis: 1 },
      { event_type: MICRO, n: MICRO_ROWS, instants: MICRO_ROWS, millis: 1 },
    ]);
    // Both one-instant groups exceed a page, so a page boundary lands inside.
    for (const row of rows.filter((r) => r.instants === 1)) {
      expect(row.n).toBeGreaterThan(PAGE_SIZE);
    }
  });
});

describe("GET /api/administrator/export/<resource> walks every page exactly once (F-31)", () => {
  for (const direction of ["desc", "asc"] as const) {
    it(`audit, created_at ${direction}: every fixture row once, in order, no truncation`, async () => {
      const exported = await runExport("audit", {
        "filter[actor]": FIXTURE_ACTOR,
        sort: `created_at.${direction}`,
      });
      expectExactly(exported, await auditIds(direction));
    });
  }

  it("audit, `sort=created_at.desc` repeated 100 times: exports like one (json_build_array takes at most 100 arguments)", async () => {
    // The cursor rendering is one `json_build_array` argument per seek column.
    // Without de-duplication this sort is 101 columns (with `id`), Postgres
    // refuses the call, and the export fails at preflight with a 502.
    const exported = await runExport("audit", {
      "filter[actor]": FIXTURE_ACTOR,
      sort: Array.from({ length: 100 }, () => "created_at.desc"),
    });
    expectExactly(exported, await auditIds("desc"));
  });

  for (const direction of ["desc", "asc"] as const) {
    it(`users, created_at ${direction}: 2,100 rows sharing one instant`, async () => {
      const exported = await runExport("users", { q: PREFIX, sort: `created_at.${direction}` });
      const expected = await db
        .selectFrom("app_users")
        .select("id")
        .where(sql<boolean>`starts_with(better_auth_user_id, ${PREFIX})`)
        .orderBy("created_at", direction)
        .orderBy("id", "asc")
        .execute();
      expectExactly(
        exported,
        expected.map((r) => r.id),
      );
    });
  }

  it("users, display_name asc: a hostile text value and the NULL block both cross a page boundary", async () => {
    const exported = await runExport("users", { q: PREFIX, sort: "display_name.asc" });
    const expected = await db
      .selectFrom("app_users")
      .select("id")
      .where(sql<boolean>`starts_with(better_auth_user_id, ${PREFIX})`)
      .orderBy(sql`display_name asc nulls last`)
      .orderBy("id", "asc")
      .execute();
    expectExactly(
      exported,
      expected.map((r) => r.id),
    );
  });

  for (const sort of [undefined, "created_at.desc", "created_at.asc"] as const) {
    it(`enterprise-apps, ${sort ?? "default sort_order asc"}: text id tiebreaker`, async () => {
      const exported = await runExport("enterprise-apps", {
        q: PREFIX,
        ...(sort ? { sort } : {}),
      });
      let expected = db
        .selectFrom("app_enterprise_applications")
        .select("id")
        .where(sql<boolean>`starts_with(id, ${PREFIX})`);
      expected = sort
        ? expected.orderBy("created_at", sort === "created_at.desc" ? "desc" : "asc")
        : expected.orderBy("sort_order", "asc");
      const rows = await expected.orderBy("id", "asc").execute();
      expectExactly(
        exported,
        rows.map((r) => r.id),
      );
    });
  }
});

describe("keyset cursor round trip through Postgres (F-31)", () => {
  /**
   * Sessions the walk rotates through, page by page: each page's cursor is
   * rendered under one TimeZone and sought under the next, including
   * half-hour and 45-minute offsets. DateStyle stays ISO here because `pg`
   * parses the typed `created_at` column only in ISO; the rendering's own
   * DateStyle independence is the next test.
   */
  const SESSIONS: ReadonlyArray<readonly [timeZone: string, dateStyle: string]> = [
    ["Etc/UTC", "ISO, MDY"],
    ["Asia/Kathmandu", "ISO, DMY"],
    ["America/St_Johns", "ISO, YMD"],
    ["Asia/Kolkata", "ISO, MDY"],
  ];

  async function walkMicroGroup(direction: "asc" | "desc", pageSize: number): Promise<string[]> {
    const sort = buildKeysetSort([{ field: "created_at", direction }]);
    const maxPages = Math.ceil(MICRO_ROWS / pageSize) + 2;
    const ids: string[] = [];
    let cursor: KeysetCursor | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const [timeZone, dateStyle] = SESSIONS[page % SESSIONS.length]!;
      const seekFrom: KeysetCursor | null = cursor;
      const rows = await db.transaction().execute(async (trx) => {
        await sql`select set_config('TimeZone', ${timeZone}, true), set_config('DateStyle', ${dateStyle}, true)`.execute(
          trx,
        );
        return applyKeyset(
          trx
            .selectFrom("app_audit_events")
            .select(["id", "created_at"])
            .where("event_type", "=", MICRO),
          sort,
          seekFrom,
          pageSize,
        ).execute();
      });
      ids.push(...rows.map((r) => r.id));
      const last = rows.at(-1);
      if (!last || rows.length < pageSize) return ids;
      cursor = keysetCursorFrom(last, sort);
    }
    return ids; // page budget spent: the walk did not terminate
  }

  for (const direction of ["asc", "desc"] as const) {
    it(`pages of 25 across one millisecond of distinct microseconds, ${direction}`, async () => {
      const expected = await db
        .selectFrom("app_audit_events")
        .select("id")
        .where("event_type", "=", MICRO)
        .orderBy("created_at", direction)
        .orderBy("id", "asc")
        .execute();
      expectExactly(
        { ids: await walkMicroGroup(direction, 25), sentinels: [] },
        expected.map((r) => r.id),
      );
    });
  }

  it("the rendered cursor names the stored instant under any DateStyle and TimeZone", async () => {
    const sort = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    for (const [timeZone, dateStyle] of [
      ["Asia/Kathmandu", "German"],
      ["America/St_Johns", "Postgres, DMY"],
      ["Asia/Kolkata", "SQL, DMY"],
    ] as const) {
      const cursor = await db.transaction().execute(async (trx) => {
        await sql`select set_config('TimeZone', ${timeZone}, true), set_config('DateStyle', ${dateStyle}, true)`.execute(
          trx,
        );
        // Only `id` and the rendering: `pg` cannot parse a non-ISO timestamp.
        const [row] = await applyKeyset(
          trx.selectFrom("app_audit_events").select("id").where("event_type", "=", BULK_FIXED),
          sort,
          null,
          1,
        ).execute();
        return keysetCursorFrom(row!, sort);
      });
      // ISO 8601 with a numeric offset, microseconds intact...
      expect(cursor.created_at, `${timeZone} / ${dateStyle}`).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.50025[+-]\d\d:\d\d$/,
      );
      // ...which a session with different settings reads back as exactly the
      // stored instant — the untyped parameter takes the column's type.
      const { rows } = await sql<{ same: boolean }>`
        select bool_and(created_at = ${cursor.created_at}) as same
        from app_audit_events where event_type = ${BULK_FIXED}
      `.execute(db);
      expect(rows[0]?.same, `${timeZone} / ${dateStyle}`).toBe(true);
    }
  });
});
