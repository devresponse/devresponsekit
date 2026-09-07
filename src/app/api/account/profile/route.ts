import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { APIError } from "better-auth/api";
import { db } from "@/db/database";
import { auth } from "@/lib/auth";
import { withTrustedClientIp } from "@/lib/client-ip";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { hasDisplayName, updateProfileSchema } from "@/lib/validation/account";
// Shared first-party JSON error envelope ({ error, message, requestId } +
// x-request-id). Despite the module name it is a generic envelope; reusing it
// here unifies the account/navigation surfaces with the admin one (P3-12).
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/account/profile
 *
 * Updates the CALLER'S OWN profile: the app-side `display_name` and the
 * Better Auth `user.name`. Both writes are self-scoped — `display_name`
 * by `actor.appUserId` (never an id from the body), and the Better Auth
 * name by the session itself (`auth.api.updateUser` acts on the current
 * user). There is no way to target another account.
 *
 * A bearer credential must carry `account.profile.write` (design §7); a
 * read-only or zero-scope key is refused with 403 `insufficient_scope`.
 * Cookie sessions carry full user authority and pass (review #184).
 *
 * Bearer callers ARE supported (review #185). `auth.api.updateUser` acts on
 * "the current session user" and so needs a session COOKIE in `headers`; a
 * bearer caller has none, so Better Auth threw `UNAUTHORIZED` on every attempt
 * and the route answered a blanket `502` — plus an `outcome: "error"` audit row
 * and a stderr trace per call, i.e. a self-inflicted error budget for a request
 * that was perfectly well-formed and correctly scoped. The name write is
 * therefore branched on the credential type: a cookie caller keeps going
 * through the session-scoped endpoint, while a bearer caller writes through
 * Better Auth's own `internalAdapter` (still the vendor API — the `user` table
 * is typed write-`never` for Kysely on purpose), targeting ONLY
 * `actor.betterAuthUserId`, which the guard resolved from the credential.
 *
 * Rate-limited per user on the mutation tier (review #28): each call reaches
 * Better Auth's `updateUser` plus an `app_users` write and an audit row, so a
 * scripted loop must hit the same ceiling the administrator mutations do.
 */

export async function PATCH(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.profile.write");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  const requestId = getOrCreateRequestId(request);
  const limited = enforceRateLimit(
    "account.profile",
    actor.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    requestId,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateProfileSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // Better Auth name (vendor table) — always self-scoped, never an id from
  // the body (review #185: cookie → the session-scoped endpoint; bearer → the
  // vendor's internal adapter against the guard-resolved principal).
  try {
    if (actor.callerKind === "session") {
      await auth.api.updateUser({
        body: { name: parsed.data.name },
        // Every server-side `auth.api.*` call shares the trusted client-IP
        // derivation (review #35) — this route is outside the proxy matcher.
        headers: withTrustedClientIp(request.headers),
      } as Parameters<typeof auth.api.updateUser>[0]);
    } else {
      const ctx = await auth.$context;
      await ctx.internalAdapter.updateUser(actor.betterAuthUserId, { name: parsed.data.name });
    }
  } catch (err) {
    // Better Auth signals client-side refusals as an `APIError` carrying an
    // HTTP status and a stable `code`. Reporting those as `502 update_failed`
    // (a gateway fault) mislabels the outcome, mis-drives client retries and
    // pollutes the error budget — map the status through, and audit only a
    // genuine 5xx service failure. `code` (never the message) goes into the
    // audit metadata so an operator can correlate without a stderr trace.
    const status = err instanceof APIError ? err.statusCode : 502;
    const code = err instanceof APIError ? (err.body?.code ?? null) : null;
    if (status < 500) {
      // A client-side refusal, like the schema 400 above: answer, don't audit.
      if (status === 401) return adminErrorResponse("unauthenticated", 401, request, { requestId });
      if (status === 403) return adminErrorResponse("forbidden", 403, request, { requestId });
      return adminErrorResponse("invalid_body", 400, request, { requestId });
    }
    await auditEvent({
      eventType: "account.profile.updated",
      outcome: "error",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      request,
      requestId,
      reason: "auth_update_failed",
      metadata: { code, status },
    });
    return adminErrorResponse("update_failed", 502, request, { requestId, cause: err });
  }

  // App-side display name — scoped strictly to the caller's own row.
  //
  // review #187: PATCH is a PARTIAL update. An OMITTED `displayName` must
  // leave the stored value alone; only an explicit `null` clears it. The old
  // `parsed.data.displayName ?? null` could not tell the two apart, so a
  // `{ "name": "…" }` PATCH silently wiped the display name.
  const displayNamePatch = hasDisplayName(parsed.data)
    ? { display_name: parsed.data.displayName }
    : {};
  const setDisplayName = "display_name" in displayNamePatch;
  await db
    .updateTable("app_users")
    .set({
      ...displayNamePatch,
      updated_at: sql`now()`,
    })
    .where("id", "=", actor.appUserId)
    .execute();

  await auditEvent({
    eventType: "account.profile.updated",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    requestId,
    // Field NAMES only — never the values.
    metadata: { fields: setDisplayName ? ["name", "displayName"] : ["name"] },
  });

  return NextResponse.json({ ok: true });
}
