import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { canAccessUser, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  isUuid,
  TARGET_OUTRANKS_ACTOR_EVENT,
  TARGET_OUTRANKS_ACTOR_REASON,
  targetOutranksActor,
} from "@/lib/admin/user-target.server";
import { ifMatchSatisfied, userEtag } from "@/lib/api-auth/etag";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/users/[id]/status
 *
 * Applies a status transition via the shared `performAdminStatusChange`
 * core (the same one `/api/administrator/users/[id]/status` uses), so the
 * REST surface is a thin adapter, not a second implementation (design
 * §8.2). Requires `admin.users.manage`.
 *
 * Honors `If-Match` for optimistic concurrency: a stale tag → `412`.
 *
 * Target authorization mirrors the administrator route (review #7): after
 * ADR-0001 scoping (`canAccessUser` → 404), a non-superadmin principal may
 * not change the status of a target who outranks them (a single-org
 * superadmin, or a more-privileged peer) → `403 forbidden` problem +
 * `admin.user.action_denied` audit row. The machine API is a thin adapter
 * over the same status core, so it must carry the same guard.
 *
 * (Design wrote `:approve`/`:block` action verbs; Next.js segments cannot
 * contain `:`, so the action is a JSON body field on a `/status`
 * sub-resource — semantically equivalent.)
 */
const ACTIONS = {
  approve: { newStatus: "active", newMembershipStatus: "active", eventType: "admin.user.approved" },
  block: { newStatus: "blocked", newMembershipStatus: "blocked", eventType: "admin.user.blocked" },
  suspend: {
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventType: "admin.user.suspended",
  },
  reactivate: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.reactivated",
  },
} as const;

const schema = z
  .object({
    action: z.enum(["approve", "block", "suspend", "reactivate"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.users.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.users.status", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);

  const current = await db
    .selectFrom("app_users")
    .select(["id", "better_auth_user_id", "primary_email", "updated_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  // ADR-0001: org admins may only change status for users in their org.
  if (!current || !(await canAccessUser(grant.caller.access, current.id))) {
    return problemResponse("not_found", 404, request);
  }
  // Privilege ordering (review #7): `grant.caller.access` is the principal's
  // full access context resolved against the credential's BOUND org, so the
  // same subset test the `/api/administrator/users/[id]/status` route applies
  // holds here. Without it a bearer/API-key org admin could block or suspend a
  // co-org superadmin — account-globally for a single-org target.
  if (
    await targetOutranksActor(grant.caller.access, {
      betterAuthUserId: current.better_auth_user_id,
    })
  ) {
    await auditUserAction(TARGET_OUTRANKS_ACTOR_EVENT, "denied", {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: current.id,
      email: current.primary_email,
      requestId: grant.requestId,
      reason: TARGET_OUTRANKS_ACTOR_REASON,
      metadata: {
        action: "status",
        surface: "v1",
        targetBetterAuthUserId: current.better_auth_user_id,
      },
    });
    return problemResponse("forbidden", 403, request, { requestId: grant.requestId });
  }
  // AUTHZ-1: confine an org admin's status change to their own org (the
  // mutation core scopes the membership + leaves account-global status alone
  // for a shared user). canAccessUser already 404s a non-superadmin without a
  // resolvable org, so a null scope here is defensive.
  const scope = resolveOrgScope(grant.caller.access);
  if (!scope) return problemResponse("not_found", 404, request, { requestId: grant.requestId });

  // Optimistic concurrency: reject a write made against a stale read.
  const ifMatch = request.headers.get("if-match");
  if (!ifMatchSatisfied(ifMatch, userEtag(current.updated_at as unknown as Date))) {
    return problemResponse("precondition_failed", 412, request, {
      detail: "The resource changed since you last read it.",
      requestId: grant.requestId,
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }

  const mapping = ACTIONS[parsed.data.action];
  const result = await performAdminStatusChange({
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    scope,
    request,
    requestId: grant.requestId,
    targetAppUserId: id,
    reason: parsed.data.reason,
    ...mapping,
  });
  if (!result.ok) return problemResponse("not_found", 404, request, { requestId: grant.requestId });

  return v1JsonResponse({ ok: true, status: result.status }, request, {
    requestId: grant.requestId,
  });
}
