import "server-only";
import { timingSafeEqual } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase, AppOauthClientsTable } from "@/db/schema/app-schema";
import { hashSecret, randomBase62 } from "@/lib/api-auth/api-key";
import {
  enterIssuanceFence,
  inIssuanceTransaction,
  type CallerSource,
} from "@/lib/api-auth/issuance-fence.server";

/**
 * Constant-time comparison of two hex digests (P2-3). A plain `!==` on a
 * JS string short-circuits at the first differing character, leaking digest
 * bytes through response timing. Both inputs are SHA-256 hex (64 chars).
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * OAuth2 client-credentials principals (design
 * docs/design-api-keys-and-tokens.md §2 + §9). A client is a non-human
 * principal that owns scopes and borrows a dedicated service user's
 * authority. The `client_secret` is shown once and stored only as a
 * SHA-256 hash, exactly like an API key.
 */

const CLIENT_ID_PREFIX = "drkc";

// Review #203: the CSPRNG base62 generator lives in ONE place
// (`api-key.ts`, covered at 100%) and is imported here. A second copy beside
// it was byte-identical, so a future fix to the shared one (alphabet, entropy,
// modulo-bias handling) would have silently missed client ids and secrets.

/** Non-secret projection of an OAuth client row (never the secret hash). */
export type OauthClientSummary = Pick<
  Selectable<AppOauthClientsTable>,
  | "id"
  | "client_id"
  | "app_user_id"
  | "organization_id"
  | "name"
  | "scopes"
  | "status"
  | "created_at"
  | "revoked_at"
>;

const SUMMARY_COLUMNS = [
  "id",
  "client_id",
  "app_user_id",
  "organization_id",
  "name",
  "scopes",
  "status",
  "created_at",
  "revoked_at",
] as const;

export interface CreateOauthClientInput {
  name: string;
  scopes: string[];
  organizationId: string | null;
  /** Existing app_users id the client acts as (its service principal). */
  serviceAppUserId: string;
  createdByAppUserId: string;
  /**
   * The credential the registering request authenticated with (F-10). When
   * given, the insert runs behind the issuance fence (`createApiKey` has the
   * same option): it waits out a concurrent eviction of the service principal
   * and is refused with `IssuingCredentialRevokedError` if that credential
   * died meanwhile. MCP self-registration has no calling credential and omits
   * it.
   */
  issuedVia?: CallerSource | null;
}

export interface CreatedOauthClient extends OauthClientSummary {
  /** The client secret — surfaced once, never stored or recoverable. */
  clientSecret: string;
}

/**
 * Registers a new client, returning the secret exactly once.
 *
 * `executor` lets a caller run the insert inside ITS transaction — MCP
 * self-registration inserts the client under a per-org advisory lock so the
 * quota check and the insert are atomic (review #51). Defaults to the shared
 * pool for every other caller.
 */
export async function createOauthClient(
  input: CreateOauthClientInput,
  executor: Kysely<AppDatabase> = db,
): Promise<CreatedOauthClient> {
  const clientId = `${CLIENT_ID_PREFIX}_${randomBase62(24)}`;
  const clientSecret = `${CLIENT_ID_PREFIX}sec_${randomBase62(40)}`;
  const secretHash = await hashSecret(clientSecret);

  const insert = (target: Kysely<AppDatabase>) =>
    target
      .insertInto("app_oauth_clients")
      .values({
        client_id: clientId,
        client_secret_hash: secretHash,
        app_user_id: input.serviceAppUserId,
        organization_id: input.organizationId,
        name: input.name,
        scopes: input.scopes,
        status: "active",
        created_by: input.createdByAppUserId,
      })
      .returning(SUMMARY_COLUMNS)
      .executeTakeFirstOrThrow();

  const issuedVia = input.issuedVia;
  const row = issuedVia
    ? await inIssuanceTransaction(async (trx) => {
        await enterIssuanceFence(trx, input.serviceAppUserId, issuedVia);
        return insert(trx);
      }, executor)
    : await insert(executor);

  return { ...row, clientSecret };
}

export interface AdminClientListQuery {
  limit: number;
  offset: number;
  status?: string;
  /** Org boundary (ADR-0001): confine to one org for an org admin; omit
   *  for SUPERADMIN (all orgs). */
  organizationId?: string;
}

export async function listOauthClients(
  query: AdminClientListQuery,
): Promise<{ items: OauthClientSummary[]; total: number }> {
  let base = db.selectFrom("app_oauth_clients");
  if (query.status) base = base.where("status", "=", query.status);
  if (query.organizationId) base = base.where("organization_id", "=", query.organizationId);

  const [items, totalRow] = await Promise.all([
    base
      .select(SUMMARY_COLUMNS)
      .orderBy("created_at", "desc")
      .limit(query.limit)
      .offset(query.offset)
      .execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  return { items, total: Number(totalRow?.total ?? 0) };
}

export async function getOauthClientById(id: string): Promise<OauthClientSummary | undefined> {
  return db
    .selectFrom("app_oauth_clients")
    .select(SUMMARY_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
}

export interface OauthClientUpdate {
  name?: string;
  scopes?: string[];
}

export async function updateOauthClient(id: string, patch: OauthClientUpdate): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (Object.keys(set).length === 0) return false;

  const result = await db
    .updateTable("app_oauth_clients")
    .set(set)
    .where("id", "=", id)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Revokes every ACTIVE client whose service principal is `ownerAppUserId`, in
 * one statement, and returns the rows it revoked. The credential eviction
 * (F-10) calls it inside its fenced transaction; see
 * `credential-eviction.server.ts`.
 */
export async function revokeActiveOauthClientsOf(
  executor: Kysely<AppDatabase>,
  ownerAppUserId: string,
  revokedByAppUserId: string,
): Promise<{ id: string; organization_id: string | null }[]> {
  return executor
    .updateTable("app_oauth_clients")
    .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: revokedByAppUserId })
    .where("app_user_id", "=", ownerAppUserId)
    .where("status", "=", "active")
    .returning(["id", "organization_id"])
    .execute();
}

export async function revokeOauthClient(id: string, revokedByAppUserId: string): Promise<boolean> {
  const result = await db
    .updateTable("app_oauth_clients")
    .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: revokedByAppUserId })
    .where("id", "=", id)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Rotates a client's secret in place, returning the new plaintext. Stamps
 * `secret_rotated_at` (app clock, matching the JWT `iat` clock) so tokens
 * minted with the OLD secret are refused by the resolver from now on
 * (review #43) — the row stays `active`, so the status check alone would
 * not retire them.
 */
export async function rotateOauthClientSecret(id: string): Promise<string | null> {
  const existing = await getOauthClientById(id);
  if (!existing || existing.status !== "active") return null;
  const clientSecret = `${CLIENT_ID_PREFIX}sec_${randomBase62(40)}`;
  const secretHash = await hashSecret(clientSecret);
  await db
    .updateTable("app_oauth_clients")
    .set({ client_secret_hash: secretHash, secret_rotated_at: new Date() })
    .where("id", "=", id)
    .execute();
  return clientSecret;
}

export interface VerifiedClient {
  clientRowId: string;
  betterAuthUserId: string;
  organizationId: string | null;
  scopes: string[];
}

/**
 * Verifies a `client_id` + `client_secret` pair for the token endpoint.
 * Returns the resolved service principal, or null on any mismatch. The
 * secret is compared by hash equality against the unique `client_id` row.
 */
export async function verifyClientCredentials(
  clientId: string,
  clientSecret: string,
): Promise<VerifiedClient | null> {
  const row = await db
    .selectFrom("app_oauth_clients as c")
    .innerJoin("app_users as u", "u.id", "c.app_user_id")
    .select([
      "c.id as id",
      "c.client_secret_hash as client_secret_hash",
      "c.status as status",
      "c.scopes as scopes",
      "c.organization_id as organization_id",
      "u.better_auth_user_id as better_auth_user_id",
    ])
    .where("c.client_id", "=", clientId)
    .executeTakeFirst();

  if (!row || row.status !== "active") return null;
  const presentedHash = await hashSecret(clientSecret);
  if (!timingSafeHexEqual(presentedHash, row.client_secret_hash)) return null;

  return {
    clientRowId: row.id,
    betterAuthUserId: row.better_auth_user_id,
    organizationId: row.organization_id,
    scopes: row.scopes,
  };
}
