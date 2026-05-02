import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { banBetterAuthUser } from "@/lib/admin/auth-admin.server";
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
 * POST /api/administrator/users/[id]/ban
 *
 * Wraps `auth.api.banUser`. Reason is required (UX: ban without
 * justification is the kind of action ops will want to look up later);
 * `expiresInSeconds` is optional — omit for indefinite per Better Auth
 * semantics. The new password / token is never logged. The reason is
 * persisted in the audit row's `reason` column (plan §5.2).
 *
 * Caller MUST hold `admin.users.ban`.
 */
const banSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  })
  .strict();

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.ban");
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
  const parsed = banSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await banBetterAuthUser(
      {
        userId: target.betterAuthUserId,
        banReason: parsed.data.reason,
        banExpiresIn: parsed.data.expiresInSeconds,
      },
      request,
    );
  } catch (err) {
    await auditUserAction("admin.user.ban_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return NextResponse.json({ error: "auth_ban_failed" }, { status: 502 });
  }

  await auditUserAction("admin.user.banned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason: parsed.data.reason,
    metadata: { expiresInSeconds: parsed.data.expiresInSeconds ?? null },
  });

  return NextResponse.json({ ok: true });
}
