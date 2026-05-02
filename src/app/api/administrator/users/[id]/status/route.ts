import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { applyAdminStatusAction } from "@/lib/admin-status.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";
import {
  isResolvedUserResponse,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/status
 *
 * Wraps the existing `applyAdminStatusAction` helper used by the legacy
 * `/api/admin/users/{approve,block,suspend,reactivate}` endpoints
 * (plan §4 + §5.2). The new endpoint takes a single `action` payload
 * (`approve` | `block` | `suspend` | `reactivate`) so the
 * Administrator UI can surface all status transitions through a single
 * route instead of four. The shared helper still validates the caller
 * holds `admin.users.manage` and emits the same audit events.
 */
const statusSchema = z
  .object({
    action: z.enum(["approve", "block", "suspend", "reactivate"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const ACTION_TO_STATUS: Record<
  z.infer<typeof statusSchema>["action"],
  {
    newStatus: "active" | "blocked" | "suspended";
    newMembershipStatus: "active" | "blocked" | "suspended";
    eventOverride: string;
  }
> = {
  approve: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventOverride: "admin.user.approved",
  },
  block: {
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventOverride: "admin.user.blocked",
  },
  suspend: {
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventOverride: "admin.user.suspended",
  },
  reactivate: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventOverride: "admin.user.reactivated",
  },
};

export async function POST(request: NextRequest, ctx: RouteContext) {
  // Permission check (defense in depth — `applyAdminStatusAction` also
  // checks). We do this here so the response shape is uniform with the
  // other admin endpoints (403 + audit on missing permission).
  const guard = await requireAdminPermission(request, "admin.users.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = statusSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const mapping = ACTION_TO_STATUS[parsed.data.action];

  // Re-shape the request body to match the legacy helper's contract
  // (`appUserId` + `reason`). We rebuild the request body since the
  // helper reads it itself; the helper expects `{appUserId, reason?}`.
  const proxiedBody = {
    appUserId: target.appUserId,
    reason: parsed.data.reason,
  };
  // Construct a synthetic request with the mapped body; preserve the
  // original headers so the audit row records the right IP / UA.
  const proxiedRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(proxiedBody),
  }) as unknown as NextRequest;

  return applyAdminStatusAction({
    request: proxiedRequest,
    newStatus: mapping.newStatus,
    newMembershipStatus: mapping.newMembershipStatus,
    eventOverride: mapping.eventOverride,
  });
}
