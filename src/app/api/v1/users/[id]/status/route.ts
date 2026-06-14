import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { canAccessUser } from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";
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
    .select(["id", "updated_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  // ADR-0001: org admins may only change status for users in their org.
  if (!current || !(await canAccessUser(grant.caller.access, current.id))) {
    return problemResponse("not_found", 404, request);
  }

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
