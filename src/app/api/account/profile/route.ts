import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auth } from "@/lib/auth";
import { withTrustedClientIp } from "@/lib/client-ip";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { updateProfileSchema } from "@/lib/validation/account";
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

  // Better Auth name (vendor table) — updated through the API for the
  // current session user only.
  try {
    await auth.api.updateUser({
      body: { name: parsed.data.name },
      // Every server-side `auth.api.*` call shares the trusted client-IP
      // derivation (review #35) — this route is outside the proxy matcher.
      headers: withTrustedClientIp(request.headers),
    } as Parameters<typeof auth.api.updateUser>[0]);
  } catch (err) {
    await auditEvent({
      eventType: "account.profile.updated",
      outcome: "error",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      request,
      requestId,
      reason: "auth_update_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("update_failed", 502, request);
  }

  // App-side display name — scoped strictly to the caller's own row.
  await db
    .updateTable("app_users")
    .set({
      display_name: parsed.data.displayName ?? null,
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
    metadata: { fields: ["name", "displayName"] },
  });

  return NextResponse.json({ ok: true });
}
