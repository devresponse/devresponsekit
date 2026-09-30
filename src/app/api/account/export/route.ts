import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { auditEvent } from "@/lib/audit.server";
// Shared first-party JSON error envelope (P3-12).
import { adminErrorResponse } from "@/lib/http/errors.server";
import { DEFAULT_ADMIN_EXPORT_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { getOrCreateRequestId } from "@/lib/http/request-id.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";
import { exportCounts, exportFilename } from "@/lib/user-data/export-shape";
import { buildUserDataExport } from "@/lib/user-data/export.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/export (F-151)
 *
 * The CALLER'S OWN data as one JSON download (an Art. 15 / PIPEDA
 * access request answered without an operator): profile, identity,
 * preferences, memberships, roles, groups, sign-in methods, sessions, API keys
 * and OAuth clients without their secrets, invitations, and the audit rows
 * about them or made by them (`buildUserDataExport`). Scoped strictly to
 * `actor.appUserId`; no id is accepted from the request.
 *
 * A COOKIE SESSION ONLY. A bearer credential acts in the one organization it
 * resolved in (MACHINE-1, `tenantConfinement`), and this document is the whole
 * account, every session's address and every organization's audit rows
 * included, so a read-scoped API key must not be able to pull it; the person
 * downloads it from Account → Overview. An impersonated session is refused by
 * the guard's IMP-1 default: an administrator exports a user through
 * `GET /api/administrator/users/[id]/export`, under `admin.users.export`.
 *
 * Rate-limited on the export tier (3 burst, one per 20 s per user): each call
 * reads a dozen tables, the audit log among them. Every download writes an
 * `account.data_exported` row with the section sizes, never the data.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  // `account.read` for the scope scan's sake (review #184): a bearer caller
  // is refused below whatever its scopes.
  const guard = await requireAccountUser(request, "account.read");
  if (!guard.ok) return guard.response;
  const { actor } = guard;
  const requestId = getOrCreateRequestId(request);

  if (actor.callerKind !== "session") {
    await auditEvent({
      eventType: "account.access.denied",
      outcome: "denied",
      reason: "session_required",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      organizationId: actor.access.organizationId,
      request,
      requestId,
      metadata: { action: "data_export", callerKind: actor.callerKind },
    });
    return adminErrorResponse("forbidden", 403, request, { requestId });
  }

  const limited = enforceRateLimit(
    "account.export",
    actor.betterAuthUserId,
    DEFAULT_ADMIN_EXPORT_LIMIT,
    request,
    requestId,
  );
  if (limited) return limited;

  const doc = await buildUserDataExport(actor.appUserId);
  // The guard resolved this id a moment ago; only a concurrent hard delete
  // (which nothing in the app performs) could remove the row.
  if (!doc) return adminErrorResponse("not_found", 404, request, { requestId });

  await auditEvent({
    eventType: "account.data_exported",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    requestId,
    metadata: { counts: exportCounts(doc), auditEventsTruncated: doc.auditEventsTruncated },
  });

  return new NextResponse(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(doc)}"`,
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
});
