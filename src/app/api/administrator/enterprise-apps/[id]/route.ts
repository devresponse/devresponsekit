import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Updateable } from "kysely";
import { db } from "@/db/database";
import type { AppEnterpriseApplicationsTable } from "@/db/schema/app-schema";
import { isForeignKeyViolation } from "@/db/pg-errors";
import { updateEnterpriseAppSchema } from "@/lib/validation/enterprise-apps";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import {
  APP_ID_RE,
  isAllowedEnterpriseOrigin,
  isConsumableAudienceFor,
  isHttpsOrigin,
} from "@/lib/admin/enterprise-apps.server";
import {
  isSsoAudienceTaken,
  isSsoAudienceUniqueViolation,
} from "@/lib/admin/enterprise-apps-audience.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { refuseWithoutCrossOrgReach } from "@/lib/admin/refusals.server";
import { canAccessOrg, hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";
import { endSsoHandoffsOfApplication } from "@/lib/sso.server";
import { logServerError } from "@/lib/observability/logger.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/enterprise-apps/:id
 *
 * Returns an enterprise application by id (text PK, not UUID).
 * Caller MUST hold `admin.apps.read`.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apps.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const row = await db
    .selectFrom("app_enterprise_applications as a")
    .leftJoin("app_organizations as o", "o.id", "a.organization_id")
    .select([
      "a.id",
      "a.label",
      "a.description",
      "a.origin",
      "a.subdomain",
      "a.sso_audience",
      "a.status",
      "a.sort_order",
      "a.organization_id",
      "o.slug as organization_slug",
      "o.name as organization_name",
      "a.created_at",
    ])
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin sees only apps owned by their org; a global app
  // (organization_id null) is SUPERADMIN-only. 404, not 403, to avoid leak.
  if (!canAccessOrg(guard.access, row.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }

  return NextResponse.json(row);
});

/**
 * PATCH /api/administrator/enterprise-apps/:id
 *
 * Updates mutable fields of an enterprise application. The `id` is a
 * stable primary key referenced by SSO handoff nonces and is therefore
 * not editable here. Caller MUST hold `admin.apps.manage`. A caller without
 * cross-org reach may change `sso_audience` only to one the app's satellite
 * can consume, `<prefix>:<id>` (400 `invalid_body`, R15), so never onto
 * another app's name (I-01). Setting `status` to `disabled` also ends the
 * app's SSO handoffs this deployment can see (F-82,
 * `endSsoHandoffsOfApplication`).
 */
export const PATCH = withAdminRoute(async function PATCH(
  request: NextRequest,
  context: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateEnterpriseAppSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  if (input.origin !== undefined && !isHttpsOrigin(input.origin)) {
    return adminErrorResponse("invalid_origin", 400, request);
  }
  // P2-5: confine the SSO redirect target to the trusted host allow-list.
  // F-83: never this deployment's own origin.
  if (input.origin !== undefined && !isAllowedEnterpriseOrigin(input.origin)) {
    return adminErrorResponse("origin_not_allowed", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id", "organization_id", "sso_audience"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin may only manage apps owned by their org. 404 to
  // avoid confirming a foreign/global app exists.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // Re-homing an app to another org (or to global) is a tenancy boundary
  // change — SUPERADMIN only. An org admin cannot move apps in or out.
  // MACHINE-2: `hasCrossOrgReach`, not `isSuperadmin` — an ORG-BOUND bearer
  // credential never takes the SUPERADMIN bypass on a platform-wide action,
  // even when its owner is a global superuser.
  if (input.organization_id !== undefined && !hasCrossOrgReach(guard.access)) {
    return refuseWithoutCrossOrgReach(guard, request, "enterprise_app_rehome", {
      applicationId: id,
    });
  }
  // R15: an org admin moves the audience only onto one the app's satellite
  // can consume, `<prefix>:<id>` of this app, as on create; the id cannot
  // change here. That also leaves it no other app's name to squat (I-01):
  // the last segment is this app's own id, a primary key no other app holds.
  // Only a CHANGE is checked: the settings form sends the stored audience
  // with every save, and an app registered before this rule keeps its
  // audience. A superadmin is not held to it (platform apps such as
  // `devresponse-portal` carry `devresponse-app:portal`).
  if (
    input.sso_audience !== undefined &&
    input.sso_audience !== existing.sso_audience &&
    !hasCrossOrgReach(guard.access) &&
    !isConsumableAudienceFor(input.sso_audience, id)
  ) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  // Review #15: an audience may not be moved onto a value another app owns.
  // F-83: nor onto this deployment's own audience. The id cannot change here,
  // so this is how an existing row could still become a self-target.
  if (input.sso_audience !== undefined && (await isSsoAudienceTaken(input.sso_audience, id))) {
    return adminErrorResponse("audience_taken", 409, request);
  }

  const updates: Updateable<AppEnterpriseApplicationsTable> = {};
  if (input.label !== undefined) updates.label = input.label;
  if (input.description !== undefined) updates.description = input.description;
  if (input.origin !== undefined) updates.origin = input.origin;
  if (input.subdomain !== undefined) updates.subdomain = input.subdomain;
  if (input.sso_audience !== undefined) updates.sso_audience = input.sso_audience;
  if (input.status !== undefined) updates.status = input.status;
  if (input.sort_order !== undefined) updates.sort_order = input.sort_order;
  if (input.organization_id !== undefined) updates.organization_id = input.organization_id;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }

  try {
    await db.updateTable("app_enterprise_applications").set(updates).where("id", "=", id).execute();
  } catch (err) {
    // Review #15: the UNIQUE index on sso_audience (migration 0005) is the
    // second line of defence behind the pre-check above — same 409 code.
    if (isSsoAudienceUniqueViolation(err)) {
      return adminErrorResponse("audience_taken", 409, request);
    }
    // F-132: by SQLSTATE and constraint, never by the (translatable) message.
    if (isForeignKeyViolation(err, "app_enterprise_applications_organization_id_fkey")) {
      return adminErrorResponse("organization_not_found", 409, request);
    }
    throw err;
  }

  // F-82: disabling the app also ends the handoff sessions it opened, where
  // this deployment's session table holds them. On every save that sets
  // `disabled`, not only a change to it, so saving again after a failed sweep
  // sweeps again. A failure still audits the update, which has committed
  // (`endedSsoSessions: null`), and then answers 500 so the operator saves
  // again.
  const sweep = updates.status === "disabled" ? await sweepSsoHandoffs(id) : undefined;

  await auditEvent({
    eventType: "admin.app.updated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    // F-32: the org that owns the app after this update, so its tenant sees
    // the change. This used to be null unless the update re-homed the app, so
    // an org admin's edits to their own org's app were invisible to that org.
    // A move to global (superadmin only) is filed under the org that lost the
    // app; the row then names no other tenant.
    organizationId: input.organization_id ?? existing.organization_id,
    targetApplicationId: id,
    request,
    metadata: {
      id,
      changes: input,
      ...(sweep === undefined ? {} : { endedSsoSessions: sweep.ended }),
    },
  });
  if (sweep && sweep.ended === null) throw sweep.failure;

  return NextResponse.json({ ok: true });
});

/**
 * DELETE /api/administrator/enterprise-apps/:id
 *
 * Deletes an enterprise application, together with the SSO handoff nonces
 * its launches left behind (F-84) and the handoff sessions it opened that
 * this deployment can see (F-82). Refuses with `application_in_use` (409)
 * only if some other row still references it; none does today.
 *
 * Caller MUST hold `admin.apps.manage`.
 */
export const DELETE = withAdminRoute(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id", "label", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin may only delete apps owned by their org; a
  // global app is SUPERADMIN-only. 404 to avoid leaking existence.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }

  let vanished = false;
  try {
    await db.transaction().execute(async (trx) => {
      // F-84: every launch leaves a handoff-nonce row naming the app, under a
      // foreign key with no ON DELETE action, and only a later launch of some
      // AVAILABLE app purged them (rows expired over an hour). So retiring an
      // app the usual way, disable it and then delete it, answered 409
      // `application_in_use`, and kept answering it when no other app was
      // launched afterwards. A nonce is a one-time replay guard for a token
      // that lives at most 60 s, not a record (the launch is audited on its
      // own), so the app's nonces go with it, in the same transaction.
      //
      // The app row is locked first: a nonce INSERT takes a key-share lock on
      // the row it references, so a launch racing this delete either commits
      // its nonce before the lock is granted (and the DELETE below removes
      // it) or waits and then fails its foreign key against the deleted app.
      const locked = await trx
        .selectFrom("app_enterprise_applications")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) {
        // Deleted by another request after the lookup above: answer as that
        // lookup would have, and claim no deletion in the audit log.
        vanished = true;
        return;
      }
      await trx
        .deleteFrom("app_sso_handoff_nonces")
        .where("target_application_id", "=", id)
        .execute();
      await trx.deleteFrom("app_enterprise_applications").where("id", "=", id).execute();
    });
  } catch (err) {
    // F-132: any 23503 on this DELETE is a row still pointing at the app,
    // whichever referencing table holds it (see `isForeignKeyViolation`).
    // Deleting nonces cannot raise one (nothing references them), so it came
    // from the app DELETE: a table a later migration points at the app.
    if (isForeignKeyViolation(err)) {
      await auditEvent({
        eventType: "admin.app.delete_blocked",
        outcome: "denied",
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: existing.organization_id,
        targetApplicationId: id,
        request,
        metadata: { id, reason: "application_in_use" },
      });
      return adminErrorResponse("application_in_use", 409, request);
    }
    throw err;
  }
  if (vanished) {
    return adminErrorResponse("application_not_found", 404, request);
  }

  // F-82: the handoff sessions the app opened go with it, like a disable
  // (PATCH above). After the commit: the adapter has its own connection, and
  // with the app and its nonces gone no new session can be opened for it.
  // Unlike a save, a failed sweep cannot be retried (the app is gone, so a
  // second DELETE answers 404), so it does not fail the delete: it is logged
  // and audited as `endedSsoSessions: null`, and the sessions it missed end at
  // their lifetime bound on the satellite (`SSO_SESSION_LIFETIME_HOURS`).
  const sweep = await sweepSsoHandoffs(id);
  if (sweep.ended === null) {
    logServerError("admin.app.sso_session_sweep_failed", {
      requestId: guard.requestId,
      err: sweep.failure,
      applicationId: id,
    });
  }

  await auditEvent({
    eventType: "admin.app.deleted",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    targetApplicationId: id,
    request,
    metadata: { id, label: existing.label, endedSsoSessions: sweep.ended },
  });

  return NextResponse.json({ ok: true });
});

/**
 * F-82: ends an app's SSO handoffs once its disable or delete has committed.
 * A failure comes back as `ended: null` rather than a throw, so the caller
 * still audits the change it has already made; each caller decides what the
 * failure answers.
 */
async function sweepSsoHandoffs(
  id: string,
): Promise<{ ended: number } | { ended: null; failure: unknown }> {
  try {
    return { ended: await endSsoHandoffsOfApplication(id) };
  } catch (failure) {
    return { ended: null, failure };
  }
}
