import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auth } from "@/lib/auth";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { updateProfileSchema } from "@/lib/validation/account";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/account/profile
 *
 * Updates the CALLER'S OWN profile: the app-side `display_name` and the
 * Better Auth `user.name`. Both writes are self-scoped — `display_name`
 * by `actor.appUserId` (never an id from the body), and the Better Auth
 * name by the session itself (`auth.api.updateUser` acts on the current
 * user). There is no way to target another account.
 */

export async function PATCH(request: NextRequest) {
  const guard = await requireAccountUser(request);
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = updateProfileSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Better Auth name (vendor table) — updated through the API for the
  // current session user only.
  try {
    await auth.api.updateUser({
      body: { name: parsed.data.name },
      headers: request.headers,
    } as Parameters<typeof auth.api.updateUser>[0]);
  } catch (err) {
    await auditEvent({
      eventType: "account.profile.updated",
      outcome: "error",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      request,
      reason: "auth_update_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return NextResponse.json({ error: "update_failed" }, { status: 502 });
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
    // Field NAMES only — never the values.
    metadata: { fields: ["name", "displayName"] },
  });

  return NextResponse.json({ ok: true });
}
