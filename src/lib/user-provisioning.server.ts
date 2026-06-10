import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import {
  resolveProviderOrganization,
  type ProviderOrganizationInput,
} from "@/lib/provider-organization-resolver";

export interface ProvisionUserInput {
  betterAuthUserId: string;
  email: string;
  emailVerified: boolean;
  provider: ProviderOrganizationInput["provider"];
  profile?: Record<string, unknown>;
  account?: Record<string, unknown>;
  displayName?: string | null;
  preferredLocale?: string;
  isSeed?: boolean;
}

export interface ProvisionUserResult {
  appUserId: string;
  organizationId: string;
  status: string;
  membershipStatus: string;
  linkedExisting: boolean;
}

/**
 * Provisions or updates an application user record after a successful
 * Better Auth authentication event.
 *
 * Responsibilities:
 *   1. Create or update `app_users`.
 *   2. Resolve provider organization, falling back to the `default` org.
 *   3. Create an organization membership when missing.
 *   4. New non-seed accounts start as `pending_approval` until approved
 *      by an administrator. Existing blocked/suspended/deactivated users
 *      keep their status — provisioning never elevates privileges.
 *   5. Stores preferred locale when provided.
 *   6. Audit-logs provisioning and account-linking outcomes.
 *
 * Threat / contract:
 *   - This function MUST NOT grant secure access by setting `active`
 *     status from arbitrary OAuth profile data — admin approval is
 *     required for all non-seed users.
 *   - Email-based account linking is enforced by Better Auth's
 *     `accountLinking` configuration; this function only links
 *     application records, never auth credentials.
 */
export async function provisionUserFromAuth(
  input: ProvisionUserInput,
): Promise<ProvisionUserResult> {
  const resolution = resolveProviderOrganization({
    provider: input.provider,
    email: input.email,
    emailVerified: input.emailVerified,
    profile: input.profile,
    account: input.account,
  });

  // 1. Find or create the target organization.
  const orgRow = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where(
      "slug",
      "=",
      resolution.providerOrganizationKey === "default"
        ? "default"
        : resolution.providerOrganizationKey,
    )
    .executeTakeFirst();

  let organizationId: string;
  if (orgRow) {
    organizationId = orgRow.id;
  } else {
    const inserted = await db
      .insertInto("app_organizations")
      .values({
        slug: resolution.providerOrganizationKey,
        name: resolution.displayName,
        status: "active",
        is_default: false,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    organizationId = inserted.id;

    await db
      .insertInto("app_provider_organizations")
      .values({
        organization_id: organizationId,
        provider: resolution.provider,
        provider_organization_key: resolution.providerOrganizationKey,
        display_name: resolution.displayName,
      })
      .onConflict((oc) => oc.columns(["provider", "provider_organization_key"]).doNothing())
      .execute();
  }

  // 2. Find or create the app_user record. Existing rows preserve status.
  const existing = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("better_auth_user_id", "=", input.betterAuthUserId)
    .executeTakeFirst();

  let appUserId: string;
  let status: string;
  let linkedExisting = false;

  if (existing) {
    appUserId = existing.id;
    status = existing.status;
    linkedExisting = true;

    // Only overwrite profile fields the provider actually supplied —
    // re-provisioning must never clear an existing display name or
    // reset a user's saved locale preference.
    await db
      .updateTable("app_users")
      .set({
        primary_email: input.email,
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.preferredLocale ? { preferred_locale: input.preferredLocale } : {}),
        updated_at: sql`now()`,
      })
      .where("id", "=", appUserId)
      .execute();
  } else {
    const initialStatus = input.isSeed ? "active" : "pending_approval";
    const inserted = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: input.betterAuthUserId,
        primary_email: input.email,
        display_name: input.displayName ?? null,
        status: initialStatus,
        preferred_locale: input.preferredLocale ?? "en",
      })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();
    appUserId = inserted.id;
    status = inserted.status;
  }

  // 3. Find or create the membership.
  const membership = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "status"])
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();

  let membershipStatus: string;
  if (membership) {
    membershipStatus = membership.status;
  } else {
    const initialMembership = input.isSeed ? "active" : "pending_approval";
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: organizationId,
        app_user_id: appUserId,
        status: initialMembership,
        source_provider: resolution.provider,
        provider_organization_key: resolution.providerOrganizationKey,
      })
      .execute();
    membershipStatus = initialMembership;
  }

  // 4. Audit the provisioning outcome.
  await auditEvent({
    eventType: linkedExisting ? "auth.account.linked" : "auth.account.pending_approval",
    outcome: "success",
    actorBetterAuthUserId: input.betterAuthUserId,
    appUserId,
    organizationId,
    provider: resolution.provider,
    email: input.email,
    metadata: {
      confidence: resolution.confidence,
      providerOrganizationKey: resolution.providerOrganizationKey,
    },
  });

  return {
    appUserId,
    organizationId,
    status,
    membershipStatus,
    linkedExisting,
  };
}
