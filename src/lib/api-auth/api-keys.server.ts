import "server-only";
import { sql, type Selectable } from "kysely";
import { db } from "@/db/database";
import type { AppApiKeysTable } from "@/db/schema/app-schema";
import { getServerEnv } from "@/lib/env";
import { generateApiKey, hashApiKey } from "@/lib/api-auth/api-key";

/**
 * API key persistence + verification (design
 * docs/design-api-keys-and-tokens.md §5).
 *
 * The plaintext is generated here, returned to the caller exactly once,
 * and only its SHA-256 hash is stored. Verification recomputes the hash
 * and looks it up by the unique index — an O(1) read with no plaintext
 * ever at rest.
 */

/** Non-secret projection of an API key row (never includes the hash). */
export type ApiKeySummary = Pick<
  Selectable<AppApiKeysTable>,
  | "id"
  | "app_user_id"
  | "organization_id"
  | "name"
  | "key_prefix"
  | "scopes"
  | "status"
  | "expires_at"
  | "last_used_at"
  | "created_at"
  | "revoked_at"
>;

const SUMMARY_COLUMNS = [
  "id",
  "app_user_id",
  "organization_id",
  "name",
  "key_prefix",
  "scopes",
  "status",
  "expires_at",
  "last_used_at",
  "created_at",
  "revoked_at",
] as const;

export interface CreateApiKeyInput {
  ownerAppUserId: string;
  organizationId: string | null;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  createdByAppUserId: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** The full secret — surfaced once, never stored or recoverable. */
  plaintext: string;
}

/** Generates, hashes, and persists a new API key. */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const env = getServerEnv();
  const { plaintext, prefix } = generateApiKey(env.API_KEY_ENV_TAG);
  const keyHash = await hashApiKey(plaintext);

  const row = await db
    .insertInto("app_api_keys")
    .values({
      app_user_id: input.ownerAppUserId,
      organization_id: input.organizationId,
      name: input.name,
      key_prefix: prefix,
      key_hash: keyHash,
      scopes: input.scopes,
      status: "active",
      expires_at: input.expiresAt,
      created_by: input.createdByAppUserId,
    })
    .returning(SUMMARY_COLUMNS)
    .executeTakeFirstOrThrow();

  return { ...row, plaintext };
}

/** Lists a single user's keys (never returns the hash or plaintext). */
export async function listApiKeysForUser(appUserId: string): Promise<ApiKeySummary[]> {
  return db
    .selectFrom("app_api_keys")
    .select(SUMMARY_COLUMNS)
    .where("app_user_id", "=", appUserId)
    .orderBy("created_at", "desc")
    .execute();
}

export interface AdminApiKeyListQuery {
  limit: number;
  offset: number;
  status?: string;
  appUserId?: string;
  /**
   * Org boundary (ADR-0001). When set, the listing is confined to keys in
   * this organization — an org admin's single org. Omitted for SUPERADMIN
   * (all orgs).
   */
  organizationId?: string;
}

/** Admin-wide key listing with a total count. */
export async function listApiKeysAdmin(
  query: AdminApiKeyListQuery,
): Promise<{ items: ApiKeySummary[]; total: number }> {
  let base = db.selectFrom("app_api_keys");
  if (query.status) base = base.where("status", "=", query.status);
  if (query.appUserId) base = base.where("app_user_id", "=", query.appUserId);
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

/** Fetches a single key by id (no secret). */
export async function getApiKeyById(id: string): Promise<ApiKeySummary | undefined> {
  return db
    .selectFrom("app_api_keys")
    .select(SUMMARY_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
}

/** Marks a key revoked. Idempotent; returns false when the id is unknown. */
export async function revokeApiKey(
  id: string,
  revokedByAppUserId: string,
  reason?: string,
): Promise<boolean> {
  const result = await db
    .updateTable("app_api_keys")
    .set({
      status: "revoked",
      revoked_at: sql`now()`,
      revoked_by: revokedByAppUserId,
      revoked_reason: reason ?? null,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Rotation: issues a fresh key with the same owner/scopes/expiry, then
 * revokes the old one. Returns the new plaintext. The two writes run in
 * one transaction so a rotation is atomic.
 */
export async function rotateApiKey(
  id: string,
  actorAppUserId: string,
): Promise<CreatedApiKey | null> {
  const existing = await getApiKeyById(id);
  if (!existing || existing.status !== "active") return null;

  const env = getServerEnv();
  const { plaintext, prefix } = generateApiKey(env.API_KEY_ENV_TAG);
  const keyHash = await hashApiKey(plaintext);

  return db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto("app_api_keys")
      .values({
        app_user_id: existing.app_user_id,
        organization_id: existing.organization_id,
        name: existing.name,
        key_prefix: prefix,
        key_hash: keyHash,
        scopes: existing.scopes,
        status: "active",
        expires_at: existing.expires_at,
        created_by: actorAppUserId,
      })
      .returning(SUMMARY_COLUMNS)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("app_api_keys")
      .set({
        status: "revoked",
        revoked_at: sql`now()`,
        revoked_by: actorAppUserId,
        revoked_reason: "rotated",
      })
      .where("id", "=", id)
      .execute();

    return { ...created, plaintext };
  });
}

export interface VerifiedApiKey {
  id: string;
  appUserId: string;
  betterAuthUserId: string;
  organizationId: string | null;
  scopes: string[];
}

/**
 * Verifies a presented plaintext key. Returns the resolved key + owner
 * identity, or null when the key is unknown / revoked / expired. The
 * owner's account status is checked downstream by the caller resolver via
 * `getUserAccessContext`.
 */
export async function verifyApiKey(plaintext: string): Promise<VerifiedApiKey | null> {
  const keyHash = await hashApiKey(plaintext);
  const row = await db
    .selectFrom("app_api_keys as k")
    .innerJoin("app_users as u", "u.id", "k.app_user_id")
    .select([
      "k.id as id",
      "k.app_user_id as app_user_id",
      "u.better_auth_user_id as better_auth_user_id",
      "k.organization_id as organization_id",
      "k.scopes as scopes",
      "k.status as status",
      "k.expires_at as expires_at",
    ])
    .where("k.key_hash", "=", keyHash)
    .executeTakeFirst();

  if (!row || row.status !== "active") return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  return {
    id: row.id,
    appUserId: row.app_user_id,
    betterAuthUserId: row.better_auth_user_id,
    organizationId: row.organization_id,
    scopes: row.scopes,
  };
}

/**
 * Fire-and-forget usage stamp. Never awaited on the request hot path and
 * never throws into it — usage telemetry must not break authentication.
 */
export function touchApiKeyUsage(id: string, ip: string | null): void {
  void db
    .updateTable("app_api_keys")
    .set({ last_used_at: sql`now()`, last_used_ip: ip })
    .where("id", "=", id)
    .execute()
    .catch(() => {
      /* best-effort */
    });
}
