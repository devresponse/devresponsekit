import "server-only";
import { sql, type Selectable } from "kysely";
import { db } from "@/db/database";
import type { AppOauthClientsTable } from "@/db/schema/app-schema";
import { hashSecret } from "@/lib/api-auth/api-key";

/**
 * OAuth2 client-credentials principals (design
 * docs/design-api-keys-and-tokens.md §2 + §9). A client is a non-human
 * principal that owns scopes and borrows a dedicated service user's
 * authority. The `client_secret` is shown once and stored only as a
 * SHA-256 hash, exactly like an API key.
 */

const CLIENT_ID_PREFIX = "drkc";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62.charAt(bytes[i]! % BASE62.length);
  return out;
}

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
}

export interface CreatedOauthClient extends OauthClientSummary {
  /** The client secret — surfaced once, never stored or recoverable. */
  clientSecret: string;
}

/** Registers a new client, returning the secret exactly once. */
export async function createOauthClient(
  input: CreateOauthClientInput,
): Promise<CreatedOauthClient> {
  const clientId = `${CLIENT_ID_PREFIX}_${randomBase62(24)}`;
  const clientSecret = `${CLIENT_ID_PREFIX}sec_${randomBase62(40)}`;
  const secretHash = await hashSecret(clientSecret);

  const row = await db
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

  return { ...row, clientSecret };
}

export interface AdminClientListQuery {
  limit: number;
  offset: number;
  status?: string;
}

export async function listOauthClients(
  query: AdminClientListQuery,
): Promise<{ items: OauthClientSummary[]; total: number }> {
  let base = db.selectFrom("app_oauth_clients");
  if (query.status) base = base.where("status", "=", query.status);

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

export async function updateOauthClient(
  id: string,
  patch: OauthClientUpdate,
): Promise<boolean> {
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

export async function revokeOauthClient(
  id: string,
  revokedByAppUserId: string,
): Promise<boolean> {
  const result = await db
    .updateTable("app_oauth_clients")
    .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: revokedByAppUserId })
    .where("id", "=", id)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** Rotates a client's secret in place, returning the new plaintext. */
export async function rotateOauthClientSecret(id: string): Promise<string | null> {
  const existing = await getOauthClientById(id);
  if (!existing || existing.status !== "active") return null;
  const clientSecret = `${CLIENT_ID_PREFIX}sec_${randomBase62(40)}`;
  const secretHash = await hashSecret(clientSecret);
  await db
    .updateTable("app_oauth_clients")
    .set({ client_secret_hash: secretHash })
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
  // Hash equality over the unique client_id row; both sides are 32-byte
  // hex digests so a length-equal compare is constant-time enough.
  if (presentedHash !== row.client_secret_hash) return null;

  return {
    clientRowId: row.id,
    betterAuthUserId: row.better_auth_user_id,
    organizationId: row.organization_id,
    scopes: row.scopes,
  };
}
