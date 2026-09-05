import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { createOauthClient, type CreatedOauthClient } from "@/lib/api-auth/oauth-clients.server";
import type { McpRegistrationStatus } from "./registration";

/**
 * Provisioning for MCP agent self-registration (Phase 2, design §10).
 *
 * A machine agent authenticates only via client-credentials, so it gets NO
 * login account: we synthesize a namespaced `better_auth_user_id` (there is
 * no FK to Better Auth's user table, and `isBetterAuthUserBanned` treats an
 * unknown id as not-banned) and create just the `app_users` row, an org
 * membership, and a ZERO-SCOPE OAuth client bound to it. Every partial-
 * failure state is inert (a principal that cannot authenticate), so no
 * transaction is required for SAFETY — {@link registerMcpAgent} wraps the
 * writes in one anyway so the per-org quota check is atomic with the insert
 * (review #51).
 *
 * What makes an agent "self-registered" — as opposed to an OAuth client an
 * admin created for a service user — is derivable from existing columns, so
 * no schema change was needed (review #51): the client's `created_by` is its
 * OWN service user (`created_by = app_user_id`, set below) AND that user
 * holds an `mcp`-sourced membership in the client's org. Every quota /
 * reaper / console query uses exactly this pair, see
 * {@link selfRegisteredClientsBase}.
 */

export interface ProvisionMcpAgentInput {
  clientName: string;
  organizationId: string;
  status: McpRegistrationStatus;
}

export interface ProvisionedMcpAgent {
  appUserId: string;
  betterAuthUserId: string;
  client: CreatedOauthClient;
}

export async function provisionMcpAgent(
  input: ProvisionMcpAgentInput,
  executor: Kysely<AppDatabase> = db,
): Promise<ProvisionedMcpAgent> {
  const betterAuthUserId = `mcp-agent:${randomUUID()}`;
  // A non-deliverable, reserved-TLD address (RFC 6761 `.invalid`) that is
  // unique per agent — machine principals never receive or send mail.
  const email = `mcp-agent-${randomUUID()}@agents.mcp.invalid`;

  const appUser = await executor
    .insertInto("app_users")
    .values({
      better_auth_user_id: betterAuthUserId,
      primary_email: email,
      display_name: input.clientName,
      status: input.status,
      preferred_locale: "en",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  await executor
    .insertInto("app_organization_memberships")
    .values({
      organization_id: input.organizationId,
      app_user_id: appUser.id,
      status: input.status,
      source_provider: "mcp",
      provider_organization_key: null,
    })
    .execute();

  const client = await createOauthClient(
    {
      name: input.clientName,
      scopes: [], // ZERO scopes — an admin must grant before the agent can act
      organizationId: input.organizationId,
      serviceAppUserId: appUser.id,
      createdByAppUserId: appUser.id, // self-registered: the marker the quota + reaper key on
    },
    executor,
  );

  return { appUserId: appUser.id, betterAuthUserId, client };
}

/**
 * Self-registered OAuth clients in an org: `created_by` is the client's own
 * service user AND that user holds an `mcp` membership in the same org (the
 * pair that distinguishes a DCR agent from an admin-created client, see the
 * module doc). `EXISTS` (not a join) keeps counts immune to duplicate
 * membership rows. `membershipStatus` narrows the membership the marker
 * requires (e.g. only ACTIVE memberships count toward the quota).
 */
function selfRegisteredClientsBase(
  executor: Kysely<AppDatabase>,
  organizationId: string,
  membershipStatus: string | null,
) {
  return executor
    .selectFrom("app_oauth_clients as c")
    .where("c.organization_id", "=", organizationId)
    .whereRef("c.created_by", "=", "c.app_user_id")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_organization_memberships as m")
          .select("m.id")
          .whereRef("m.app_user_id", "=", "c.app_user_id")
          .where("m.organization_id", "=", organizationId)
          .where("m.source_provider", "=", "mcp")
          .$if(membershipStatus !== null, (qb) =>
            qb.where("m.status", "=", membershipStatus as string),
          ),
      ),
    );
}

/**
 * Count of SANCTIONED self-registered clients bound to an org — the per-org
 * self-registration quota (P1-2, review #51). Only an active client whose
 * service account holds an ACTIVE `mcp` membership counts:
 *
 *   - A self-registered agent awaiting approval has a `pending_approval`
 *     membership (and cannot mint a usable token), so it must NOT consume a
 *     quota slot — otherwise an unauthenticated attacker could fill an org's
 *     quota with junk pending registrations and block legitimate ones.
 *   - An ADMIN-created client (created_by ≠ its service user, and no `mcp`
 *     membership) is excluded too: the quota bounds what the PUBLIC endpoint
 *     can create, not what an admin deliberately provisioned, so the two can
 *     never lock each other out.
 *
 * In `open` mode a self-registration is active at once and does count — the
 * quota is then a hard ceiling on the public endpoint by design; the
 * pending-registration reaper only helps `approval` mode. Pass the
 * transaction as `executor` to count under {@link registerMcpAgent}'s lock.
 */
export async function countSelfRegisteredMcpClientsForOrg(
  organizationId: string,
  executor: Kysely<AppDatabase> = db,
): Promise<number> {
  const row = await selfRegisteredClientsBase(executor, organizationId, "active")
    .select(sql<string>`count(*)`.as("count"))
    .where("c.status", "=", "active")
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type RegisterMcpAgentResult =
  { ok: true; agent: ProvisionedMcpAgent } | { ok: false; reason: "quota_exceeded" };

/**
 * Quota-checked self-registration, atomic per org (review #51).
 *
 * The previous route-level `count → insert` was a TOCTOU: N concurrent
 * requests each saw `count < max` and all inserted, so the quota was only
 * advisory under load. Here the count and the provisioning run in ONE
 * transaction that first takes `pg_advisory_xact_lock` keyed on the org, so
 * registrations for the same org serialize (different orgs do not contend)
 * and the (N+1)th request observes the N inserts before it. The lock is
 * transaction-scoped, so a thrown error releases it with the rollback.
 *
 * `maxPerOrg <= 0` means unlimited: no lock, no count, plain provisioning.
 */
export async function registerMcpAgent(
  input: ProvisionMcpAgentInput & { maxPerOrg: number },
): Promise<RegisterMcpAgentResult> {
  return db.transaction().execute(async (trx) => {
    if (input.maxPerOrg > 0) {
      // Two-int4 form: a namespace hash + the org hash, so this lock cannot
      // collide with another advisory lock keyed on a bare id.
      await sql`select pg_advisory_xact_lock(hashtext('mcp.register'), hashtext(${input.organizationId}))`.execute(
        trx,
      );
      const used = await countSelfRegisteredMcpClientsForOrg(input.organizationId, trx);
      if (used >= input.maxPerOrg) return { ok: false, reason: "quota_exceeded" };
    }
    const agent = await provisionMcpAgent(input, trx);
    return { ok: true, agent };
  });
}
