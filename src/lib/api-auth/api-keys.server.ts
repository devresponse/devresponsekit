import "server-only";
import { sql, type Kysely, type Selectable, type SqlBool } from "kysely";
import { db } from "@/db/database";
import type { AppApiKeysTable, AppDatabase } from "@/db/schema/app-schema";
import { getServerEnv } from "@/lib/env";
import { generateApiKey, hashApiKey } from "@/lib/api-auth/api-key";
import {
  enterIssuanceFence,
  inIssuanceTransaction,
  lockOwnerForIssuance,
  type CallerSource,
} from "@/lib/api-auth/issuance-fence.server";

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
  /**
   * The credential the issuing request authenticated with (F-10). When given,
   * the insert runs behind the issuance fence: it waits out a concurrent
   * credential eviction of the owner and is refused with
   * `IssuingCredentialRevokedError` if that credential died meanwhile. Every
   * route passes its caller's; omitted (or `null`, a legacy token) there is
   * nothing to re-check and the key is inserted directly.
   */
  issuedVia?: CallerSource | null;
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

  const insert = (executor: Kysely<AppDatabase>) =>
    executor
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

  const issuedVia = input.issuedVia;
  const row = issuedVia
    ? await inIssuanceTransaction(async (trx) => {
        await enterIssuanceFence(trx, input.ownerAppUserId, issuedVia);
        return insert(trx);
      })
    : await insert(db);

  return { ...row, plaintext };
}

/**
 * Optional tenant confinement for {@link listApiKeysForUser} (IMP-1).
 *
 * `app_user_id` is an ACCOUNT-WIDE key: one identity can hold keys in every
 * organization it is a member of, so the self-scoped listing spans tenants by
 * construction. That is right for the user themselves and wrong for a session
 * an administrator has BORROWED, which must see no further than the tenant the
 * impersonation is confined to. Supplying this narrows the listing to one org;
 * a `null` organizationId means "the caller resolved no org", which lists
 * NOTHING rather than everything (fail closed).
 */
export interface ApiKeyOrgConfinement {
  organizationId: string | null;
}

/**
 * Lists a single user's keys (never returns the hash or plaintext).
 *
 * Pass `confinement` to additionally restrict the rows to one organization —
 * see {@link ApiKeyOrgConfinement}. Omitted, the listing is account-wide,
 * which is the pre-existing behaviour for a caller acting as themselves.
 */
export async function listApiKeysForUser(
  appUserId: string,
  confinement?: ApiKeyOrgConfinement,
): Promise<ApiKeySummary[]> {
  // Fail closed: a confined caller with no resolvable org has no tenant to
  // list in, so it must see an empty list — never the unfiltered account-wide
  // set a dropped predicate would return (and `organization_id = NULL` would
  // not be that predicate anyway).
  const confinedOrgId = confinement?.organizationId;
  if (confinement && confinedOrgId == null) return [];

  const base = db
    .selectFrom("app_api_keys")
    .select(SUMMARY_COLUMNS)
    .where("app_user_id", "=", appUserId);
  const scoped = confinedOrgId == null ? base : base.where("organization_id", "=", confinedOrgId);
  return scoped.orderBy("created_at", "desc").execute();
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
      // F-41: a unique tiebreaker, so OFFSET pages slice one total order.
      .orderBy("id", "asc")
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
 * Revokes every ACTIVE key `ownerAppUserId` owns in one statement and returns
 * the rows it revoked. The credential eviction (F-10) calls it inside its
 * fenced transaction; see `credential-eviction.server.ts`.
 */
export async function revokeActiveApiKeysOf(
  executor: Kysely<AppDatabase>,
  ownerAppUserId: string,
  revokedByAppUserId: string,
  reason: string,
): Promise<{ id: string; organization_id: string | null }[]> {
  return executor
    .updateTable("app_api_keys")
    .set({
      status: "revoked",
      revoked_at: sql`now()`,
      revoked_by: revokedByAppUserId,
      revoked_reason: reason,
    })
    .where("app_user_id", "=", ownerAppUserId)
    .where("status", "=", "active")
    .returning(["id", "organization_id"])
    .execute();
}

/**
 * Rotation: issues a fresh key with the same owner/scopes/expiry and revokes
 * the old one, in one transaction. Returns the new plaintext, or `null` when
 * the key is missing or no longer active.
 *
 * The old key is retired FIRST, and only while it is still `active`, so a key
 * revoked after the check above (a manual revoke, a concurrent rotation, or a
 * credential eviction) is never rotated into a live successor, and its
 * revoker and reason are kept. The transaction takes the issuance lock on the
 * owner first (F-10, `issuance-fence.server.ts`). An eviction of the owner
 * then either waits for the rotation to commit and revokes the successor, or
 * commits first, and the retire below finds the old key already revoked.
 * Rotating a key the eviction is about to revoke therefore never lets a
 * successor escape.
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

  return inIssuanceTransaction(async (trx) => {
    await lockOwnerForIssuance(trx, existing.app_user_id);

    const retired = await trx
      .updateTable("app_api_keys")
      .set({
        status: "revoked",
        revoked_at: sql`now()`,
        revoked_by: actorAppUserId,
        revoked_reason: "rotated",
      })
      .where("id", "=", id)
      .where("status", "=", "active")
      .returning("id")
      .executeTakeFirst();
    if (!retired) return null;

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

    return { ...created, plaintext };
  });
}

export interface VerifiedApiKey {
  id: string;
  appUserId: string;
  betterAuthUserId: string;
  organizationId: string | null;
  scopes: string[];
  /**
   * The key's own expiry (null = never). The token endpoint caps a minted
   * JWT's lifetime at this instant so a token can never outlive the key it
   * came from (review #48).
   */
  expiresAt: Date | null;
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
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

/**
 * Per-process record of when each key was last STAMPED, so a burst of
 * requests with the same key costs one write instead of one per request
 * (review #201).
 *
 * Bounded on purpose: the key space is `app_api_keys.id` (a uuid the caller
 * cannot invent — an unknown key never reaches here because `verifyApiKey`
 * returned null), but a long-lived instance serving many keys should still
 * not grow this map without limit. Map iteration order is insertion order, so
 * dropping from the front evicts the oldest entries in O(1) each. An evicted
 * key simply gets one extra write on its next request.
 */
const lastUsageTouchMs = new Map<string, number>();
/** Hard cap on the throttle map; exported so the eviction test cannot drift. */
export const MAX_TRACKED_USAGE_KEYS = 5_000;

/** Test-only: forget the in-process throttle state. */
export function __resetApiKeyUsageThrottleForTests(): void {
  lastUsageTouchMs.clear();
}

/**
 * Fire-and-forget usage stamp. Never awaited on the request hot path and
 * never throws into it — usage telemetry must not break authentication.
 *
 * THROTTLED (review #201): this used to issue an UPDATE on every
 * authenticated API-key request — a write (and a dead tuple) per read, on the
 * hottest path in the machine API. `last_used_at` is coarse telemetry
 * ("is this key still in use?"), not an audit record — the audit trail is
 * `app_audit_events` — so it is written at most once per
 * `API_KEY_USAGE_TOUCH_INTERVAL_SECONDS` per key:
 *
 *   1. an in-process check that skips the DB round trip entirely, and
 *   2. the same interval as a predicate on the UPDATE itself, so a second
 *      instance (or a restarted one, whose map is empty) cannot write more
 *      often than the interval either.
 *
 * Both layers are needed: (1) without (2), N lambdas each write once per
 * interval; (2) without (1) still pays a round trip per request.
 *
 * `nowMs` is injectable for deterministic tests; production never passes it.
 */
export function touchApiKeyUsage(id: string, ip: string | null, nowMs: number = Date.now()): void {
  const intervalSeconds = getServerEnv().API_KEY_USAGE_TOUCH_INTERVAL_SECONDS;

  const lastTouch = lastUsageTouchMs.get(id);
  if (lastTouch !== undefined && nowMs - lastTouch < intervalSeconds * 1000) return;

  if (lastTouch === undefined && lastUsageTouchMs.size >= MAX_TRACKED_USAGE_KEYS) {
    // `size >= MAX_TRACKED_USAGE_KEYS` guarantees a first entry, so no empty check.
    lastUsageTouchMs.delete(lastUsageTouchMs.keys().next().value!);
  }
  // Re-insert so the entry moves to the back of the eviction order.
  lastUsageTouchMs.delete(id);
  lastUsageTouchMs.set(id, nowMs);

  void db
    .updateTable("app_api_keys")
    .set({ last_used_at: sql`now()`, last_used_ip: ip })
    .where("id", "=", id)
    // Layer 2 of the throttle: the DB refuses the write itself when the row
    // was stamped within the interval, so instances that do not share the
    // in-process map above still cannot write more often than the interval.
    // The seconds value is an integer from the validated env schema and is
    // inlined as a literal (no user input reaches this SQL). The fragment is
    // PARENTHESISED on purpose: Kysely splices a raw `where` in verbatim and
    // joins clauses with AND, so an unwrapped `a or b` would bind as
    // `(id = ? and a) or b` and stamp every stale row in the table.
    .where(
      sql<SqlBool>`(last_used_at is null or last_used_at < now() - make_interval(secs => ${sql.lit(intervalSeconds)}))`,
    )
    .execute()
    .catch(() => {
      /* best-effort */
    });
}
