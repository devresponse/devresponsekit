import "server-only";
import { CompiledQuery } from "kysely";
import { db } from "@/db/database";

/**
 * F-151 — the application's handle on `app_users_pseudonymise(uuid)`
 * (migration 0008).
 *
 * The function does the erasure in ONE statement, as the table owner
 * (SECURITY DEFINER), so it can pass the audit trigger's pseudonymisation
 * exemption that no application credential can: it refuses an account that is
 * not soft-deleted (SQLSTATE 55000), replaces the person's addresses, name and
 * picture, deletes their sessions, sign-in credentials, pending reset tokens
 * and locale preferences, blanks the mail addressed to them, pseudonymises the
 * audit rows that name them (an invitation's `metadata.email` included) and
 * clears the IP address and user agent of their own requests. It is
 * idempotent, and records every call in its own `db.user.pseudonymised` audit
 * row, the trace of a call made outside the admin route. What stays and why
 * is in the migration's header and in
 * docs/admin-manager.md, "Data export and erasure (F-151)".
 *
 * Called like the retention function (`pruneAuditEvents`), with a raw compiled
 * query: Kysely has no builder for a bare function call's jsonb result.
 */
export interface ErasureResult {
  /** The address the account now carries (`erasedEmailFor`). */
  pseudonym: string;
  /** True when the account had been erased before; every count is then 0. */
  alreadyErased: boolean;
  sessions: number;
  accounts: number;
  verifications: number;
  localePreferences: number;
  apiKeys: number;
  oauthClients: number;
  invitations: number;
  outbox: number;
  auditEvents: number;
}

/**
 * True for the error the function raises for an account that is not
 * soft-deleted (SQLSTATE 55000, object_not_in_prerequisite_state): a restore
 * that committed between the route's status check and the call.
 */
export function isNotDeactivatedError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "55000";
}

export async function pseudonymiseUser(appUserId: string): Promise<ErasureResult> {
  const res = await db.executeQuery(
    CompiledQuery.raw("select app_users_pseudonymise($1::uuid) as result", [appUserId]),
  );
  const result = (res.rows[0] as { result?: ErasureResult } | undefined)?.result;
  if (!result) throw new Error("app_users_pseudonymise returned no result");
  return result;
}
