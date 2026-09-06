/**
 * Projection of a Better Auth session row for the administrator API
 * (review #67/#194).
 *
 * `auth.api.listUserSessions` returns the FULL `session` rows — including
 * `token`, which is the bearer credential of that session: anyone holding it
 * can present it as the cookie value and become that user. The console only
 * needs metadata to render and an `id` to revoke by, so the route hands out
 * this explicit allow-listed shape and never the raw row. Kept free of
 * `server-only` so the route tests exercise the real projection while the
 * Better Auth wrapper module is mocked.
 */
export interface SessionItem {
  /** Better Auth session id — what `DELETE …/sessions/{sessionId}` takes. */
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** The impersonating admin's Better Auth user id, for an impersonation session. */
  impersonatedBy: string | null;
}

/** The ONLY keys a session item carries — pinned by the route test. */
export const SESSION_ITEM_KEYS: ReadonlyArray<keyof SessionItem> = [
  "id",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "ipAddress",
  "userAgent",
  "impersonatedBy",
];

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dates come back as `Date` from the Kysely adapter, as ISO strings over HTTP. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Better Auth returns `{ sessions: [...] }` or a bare array depending on the
 * plugin version; both normalize to the array of raw rows.
 */
export function normalizeSessionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.sessions)) return raw.sessions;
  return [];
}

/** Picks the allow-listed fields; every other key (`token` above all) is dropped. */
export function toSessionItem(raw: unknown): SessionItem {
  const row: RawRecord = isRecord(raw) ? raw : {};
  return {
    id: typeof row.id === "string" ? row.id : "",
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    expiresAt: toIso(row.expiresAt),
    ipAddress: toNullableString(row.ipAddress),
    userAgent: toNullableString(row.userAgent),
    impersonatedBy: toNullableString(row.impersonatedBy),
  };
}

/**
 * Resolves a session `id` to its token server-side, scoped to the rows the
 * caller already listed for the TARGET user — so a caller can neither learn a
 * token nor revoke another user's session by guessing an id. `null` when no
 * row of the target's carries that id.
 */
export function findSessionToken(rawList: unknown, sessionId: string): string | null {
  for (const raw of normalizeSessionList(rawList)) {
    if (!isRecord(raw) || raw.id !== sessionId) continue;
    return typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null;
  }
  return null;
}
