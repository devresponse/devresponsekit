import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import {
  listMcpAgents,
  parseMcpAgentListQuery,
  withMcpAgentProvenance,
} from "@/lib/mcp/agents.server";
import { provisionMcpAgent } from "@/lib/mcp/registration.server";

/**
 * DB-BACKED tests for the paged agents listing (review #13): the SQL behind
 * the console + `GET /api/administrator/mcp-agents`. Verifies against a live
 * Postgres that
 *   - pending agents sort FIRST even when buried under newer junk,
 *   - `filter[status]` narrows to pending / active / revoked using the same
 *     definition the derived `status` column reports,
 *   - pages are disjoint and complete (deterministic tiebreaker) and `total`
 *     is the filtered count,
 *   - `pendingCount` is scope-wide (independent of page AND filter),
 *   - an org admin sees only their org,
 *   - the console's approval context (I-03) carries the bound org and the
 *     source IP of the agent's `mcp.client.registered` audit row, in scope only.
 *
 * Driven by `pnpm test:db`. Fixtures use `__dbtest_` and self-clean.
 */
const PREFIX = "__dbtest_mcplist_";
const createdUserIds: string[] = [];
let orgId: string;
let otherOrgId: string;
let pendingId: string; // the one legitimate pending agent, oldest of all
let otherPendingId: string; // the other org's pending agent

const superadmin = { permissions: [SUPERADMIN_PERMISSION], organizationId: null } as never;
const orgAdmin = () => ({ permissions: ["admin.clients.read"], organizationId: orgId }) as never;
const q = (qs: string) => parseMcpAgentListQuery(new URLSearchParams(qs));

async function makeOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function provision(
  organizationId: string,
  status: "active" | "pending_approval",
  name: string,
  ageMinutes: number,
): Promise<string> {
  const p = await provisionMcpAgent({ clientName: `${PREFIX}${name}`, organizationId, status });
  createdUserIds.push(p.appUserId);
  // Distinct, controlled created_at values so "newest first" is testable.
  await db
    .updateTable("app_oauth_clients")
    .set({ created_at: sql`now() - make_interval(mins => ${ageMinutes})` })
    .where("id", "=", p.client.id)
    .execute();
  return p.client.id;
}

beforeAll(async () => {
  orgId = await makeOrg("main");
  otherOrgId = await makeOrg("other");
  // Oldest row: the legitimate pending agent. Then 12 newer approved agents
  // (2 of them revoked) — more than one page of 5 — plus one in another org.
  pendingId = await provision(orgId, "pending_approval", "legit-pending", 1000);
  for (let i = 0; i < 12; i += 1) {
    const clientId = await provision(orgId, "active", `active-${i}`, 100 - i);
    if (i < 2) {
      await db
        .updateTable("app_oauth_clients")
        .set({ status: "revoked", revoked_at: sql`now()` })
        .where("id", "=", clientId)
        .execute();
    }
  }
  otherPendingId = await provision(otherOrgId, "pending_approval", "other-org-pending", 5);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Audit rows are append-only; the sanctioned retention GUC removes them,
    // and first, since `app_audit_events.app_user_id` references the users.
    await db.transaction().execute(async (trx) => {
      await sql`set local app.audit_retention = 'on'`.execute(trx);
      await trx.deleteFrom("app_audit_events").where("app_user_id", "in", createdUserIds).execute();
    });
    await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", createdUserIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", createdUserIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", createdUserIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

/** Only this suite's rows, in the order the query returned them. */
function ours<T extends { name: string }>(items: T[]): T[] {
  return items.filter((i) => i.name.startsWith(PREFIX));
}

describe("listMcpAgents (DB-backed, review #13)", () => {
  it("surfaces the OLDEST pending agent on page 1 ahead of newer junk", async () => {
    const page = await listMcpAgents(orgAdmin(), q("pageSize=5"));
    const first = ours(page.items)[0];
    expect(first?.clientRowId).toBe(pendingId);
    expect(first?.status).toBe("pending");
    // After the pending block, newest first.
    const rest = ours(page.items).slice(1);
    const ages = rest.map((r) => r.createdAt);
    expect([...ages].sort().reverse()).toEqual(ages);
  });

  it("reports the scope-wide pendingCount on every page and under every filter", async () => {
    const pageOne = await listMcpAgents(orgAdmin(), q("pageSize=5"));
    const pageThree = await listMcpAgents(orgAdmin(), q("pageSize=5&page=3"));
    const revokedOnly = await listMcpAgents(orgAdmin(), q("filter[status]=revoked"));
    expect(pageOne.pendingCount).toBe(1);
    expect(pageThree.pendingCount).toBe(1);
    expect(revokedOnly.pendingCount).toBe(1); // NOT 0 — the badge must stay truthful
    expect(revokedOnly.total).toBe(2);
    expect(revokedOnly.items.every((i) => i.status === "revoked")).toBe(true);
  });

  it("filters by status with the same definition the derived column reports", async () => {
    const pending = await listMcpAgents(orgAdmin(), q("filter[status]=pending"));
    expect(pending.total).toBe(1);
    expect(pending.items[0]).toMatchObject({
      clientRowId: pendingId,
      status: "pending",
      userStatus: "pending_approval",
      clientStatus: "active",
    });
    const active = await listMcpAgents(orgAdmin(), q("filter[status]=active&pageSize=200"));
    expect(active.total).toBe(10);
    expect(active.items.every((i) => i.status === "active" && i.clientStatus === "active")).toBe(
      true,
    );
  });

  it("pages are disjoint, complete, and total is the filtered count", async () => {
    const seen = new Set<string>();
    let total = -1;
    for (let page = 1; page <= 3; page += 1) {
      const result = await listMcpAgents(orgAdmin(), q(`pageSize=5&page=${page}`));
      total = result.total;
      expect(result.page).toBe(page);
      expect(result.pageSize).toBe(5);
      for (const item of result.items) {
        expect(seen.has(item.clientRowId)).toBe(false);
        seen.add(item.clientRowId);
      }
    }
    expect(total).toBe(13);
    expect(seen.size).toBe(13);
    // Past the end: empty page, but the true total still comes back.
    const past = await listMcpAgents(orgAdmin(), q("pageSize=5&page=9"));
    expect(past.items).toEqual([]);
    expect(past.total).toBe(13);
  });

  it("confines an org admin to their org (the other org's pending agent is invisible)", async () => {
    const mine = await listMcpAgents(orgAdmin(), q("pageSize=200"));
    expect(mine.items.every((i) => i.organizationId === orgId)).toBe(true);
    expect(mine.items.some((i) => i.name === `${PREFIX}other-org-pending`)).toBe(false);
    const all = await listMcpAgents(superadmin, q("filter[status]=pending&pageSize=200"));
    expect(
      ours(all.items)
        .map((i) => i.organizationId)
        .sort(),
    ).toEqual([orgId, otherOrgId].sort());
  });
});

describe("withMcpAgentProvenance (DB-backed, I-03)", () => {
  /**
   * Writes the row the register route writes, with the given source address.
   * It mirrors `auditEvent` in src/app/api/mcp/register/route.ts: that call's
   * `appUserId` (the service account) and `request` (the source of
   * `ip_address`) are what the provenance lookup reads, and
   * tests/integration/mcp-register-route.test.ts pins both.
   */
  async function registrationAudit(clientRowId: string, ip: string): Promise<void> {
    const client = await db
      .selectFrom("app_oauth_clients")
      .select(["app_user_id", "organization_id", "client_id"])
      .where("id", "=", clientRowId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: "mcp.client.registered",
        outcome: "success",
        app_user_id: client.app_user_id,
        organization_id: client.organization_id,
        ip_address: ip,
        metadata: JSON.stringify({ clientId: client.client_id }),
      })
      .execute();
  }

  beforeAll(async () => {
    await registrationAudit(pendingId, "203.0.113.7");
    await registrationAudit(otherPendingId, "198.51.100.9");
  });

  it("adds the bound organization and the registration's source IP", async () => {
    const page = await listMcpAgents(orgAdmin(), q("pageSize=200"));
    const rows = await withMcpAgentProvenance(orgAdmin(), ours(page.items));
    const pending = rows.find((row) => row.clientRowId === pendingId);
    expect(pending).toMatchObject({
      organizationName: "DBTest main",
      organizationSlug: `${PREFIX}main`,
      registeredIp: "203.0.113.7",
      status: "pending",
    });
    // No audit row → no address, and every row still names its org.
    const others = rows.filter((row) => row.clientRowId !== pendingId);
    expect(others.length).toBe(12);
    expect(others.every((row) => row.registeredIp === null)).toBe(true);
    expect(others.every((row) => row.organizationName === "DBTest main")).toBe(true);
  });

  it("adds nothing for an agent outside the caller's scope", async () => {
    const all = await listMcpAgents(superadmin, q("filter[status]=pending&pageSize=200"));
    const foreign = ours(all.items).find((row) => row.clientRowId === otherPendingId)!;
    const [asOrgAdmin] = await withMcpAgentProvenance(orgAdmin(), [foreign]);
    expect(asOrgAdmin).toMatchObject({
      organizationName: null,
      organizationSlug: null,
      registeredIp: null,
    });
    const [asSuperadmin] = await withMcpAgentProvenance(superadmin, [foreign]);
    expect(asSuperadmin).toMatchObject({
      organizationName: "DBTest other",
      registeredIp: "198.51.100.9",
    });
  });
});
