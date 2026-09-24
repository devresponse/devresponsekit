import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { normalizeClientIp } from "@/lib/client-ip";

/**
 * DB-BACKED test for F-16: the client IP reaches `inet` columns normalized.
 *
 * `app_audit_events.ip_address` is `inet`. The client IP used to be the raw
 * trusted hop of `X-Forwarded-For`, so a load balancer that appends the source
 * port (`203.0.113.5:51234`, Azure style) or a client that sends
 * `X-Forwarded-For: x` to a directly exposed origin made the audit INSERT fail
 * with 22P02. That happens AFTER the mutation it records has committed: the
 * caller got a 500 and the action had no audit row. The mocked unit suites
 * prove what `getClientIp` returns; only Postgres proves that `inet` accepts
 * it, so this drives the real `auditEvent` with each hostile hop and reads
 * the stored address back, then asks Postgres about a few hundred generated
 * addresses (the unit property can only check `net.isIP`, which is looser
 * than `inet`: it accepts a zone id).
 *
 * Fixtures use the `__dbtest_clientip_` prefix; the rows are removed through
 * the sanctioned retention GUC (the table is append-only).
 */
const PREFIX = "__dbtest_clientip_";
const ACTOR = `${PREFIX}actor`;

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
}

async function storedIp(requestId: string): Promise<string | null> {
  const row = await db
    .selectFrom("app_audit_events")
    .select(sql<string | null>`host(ip_address)`.as("ip"))
    .where("request_id", "=", requestId)
    .executeTakeFirstOrThrow();
  return row.ip;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("client IP → inet columns (F-16)", () => {
  it("the raw hops are what inet refused: 22P02 (the pre-fix failure)", async () => {
    for (const raw of ["203.0.113.5:51234", "[2001:db8::1]:443", "x"]) {
      await expect(
        db
          .insertInto("app_audit_events")
          .values({
            event_type: `${PREFIX}raw`,
            outcome: "success",
            actor_better_auth_user_id: ACTOR,
            ip_address: raw,
          })
          .execute(),
        raw,
      ).rejects.toMatchObject({ code: "22P02" });
    }
  });

  const vectors: Array<[string, string, string | null]> = [
    ["IPv4 with a load balancer's port", "198.51.100.7, 203.0.113.5:51234", "203.0.113.5"],
    ["bracketed IPv6 with a port", "[2001:db8::1]:443", "2001:db8::1"],
    ["IPv4-mapped IPv6", "::ffff:203.0.113.5", "203.0.113.5"],
    ["IPv4-compatible IPv6 (dotted tail)", "::203.0.113.5", "::203.0.113.5"],
    ["garbage", "x", null],
    ["IPv6 zone id", "[fe80::1%eth0]:80", null],
  ];

  for (const [name, xff, expected] of vectors) {
    it(`${name}: auditEvent stores ${String(expected)} and does not throw`, async () => {
      const requestId = `${PREFIX}${crypto.randomUUID()}`;
      await expect(
        auditEvent({
          eventType: `${PREFIX}probe`,
          outcome: "success",
          actorBetterAuthUserId: ACTOR,
          requestId,
          request: { headers: new Headers({ "x-forwarded-for": xff }) },
        }),
      ).resolves.toBeUndefined();
      expect(await storedIp(requestId)).toBe(expected);
    });
  }

  it("PROPERTY: every address normalizeClientIp returns is one inet accepts", async () => {
    const port = fc.integer({ min: 0, max: 65535 });
    const hop = fc.oneof(
      fc.ipV4(),
      fc.ipV4Extended(),
      fc.ipV6(),
      fc.tuple(fc.ipV6(), port).map(([ip, p]) => `[${ip}]:${p}`),
      fc.tuple(fc.ipV4(), port).map(([ip, p]) => `${ip}:${p}`),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(hop, { minLength: 1, maxLength: 50 }), async (hops) => {
        const addresses = hops.map(normalizeClientIp).filter((ip): ip is string => ip !== null);
        // One round trip per run. pg_input_is_valid (Postgres 16+; CI and
        // docker-compose run 17) names each rejected value instead of
        // aborting on the first 22P02, so a failure shrinks to the address.
        const { rows } = await sql<{ v: string }>`
          select v from unnest(${addresses}::text[]) as t(v)
          where not pg_input_is_valid(v, 'inet')
        `.execute(db);
        expect(rows.map((row) => row.v)).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });
});
