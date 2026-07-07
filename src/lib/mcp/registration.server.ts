import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/db/database";
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
 * transaction is required for safety.
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
): Promise<ProvisionedMcpAgent> {
  const betterAuthUserId = `mcp-agent:${randomUUID()}`;
  // A non-deliverable, reserved-TLD address (RFC 6761 `.invalid`) that is
  // unique per agent — machine principals never receive or send mail.
  const email = `mcp-agent-${randomUUID()}@agents.mcp.invalid`;

  const appUser = await db
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

  await db
    .insertInto("app_organization_memberships")
    .values({
      organization_id: input.organizationId,
      app_user_id: appUser.id,
      status: input.status,
      source_provider: "mcp",
      provider_organization_key: null,
    })
    .execute();

  const client = await createOauthClient({
    name: input.clientName,
    scopes: [], // ZERO scopes — an admin must grant before the agent can act
    organizationId: input.organizationId,
    serviceAppUserId: appUser.id,
    createdByAppUserId: appUser.id, // self-registered
  });

  return { appUserId: appUser.id, betterAuthUserId, client };
}

/** Count of active OAuth clients bound to an org — the coarse per-org quota. */
export async function countActiveOauthClientsForOrg(organizationId: string): Promise<number> {
  const row = await db
    .selectFrom("app_oauth_clients")
    .select(sql<string>`count(*)`.as("count"))
    .where("organization_id", "=", organizationId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
