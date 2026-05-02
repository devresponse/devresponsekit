import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  sendBetterAuthPasswordResetEmail,
  setBetterAuthUserPassword,
} from "@/lib/admin/auth-admin.server";
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
 * POST /api/administrator/users/[id]/password
 *
 * Two modes (plan §4 + §5.2):
 *   - `mode: "set"`     — admin sets a new password directly.
 *   - `mode: "reset_email"` — triggers a password-reset email via
 *                             Better Auth's `forgetPassword` flow.
 *
 * The new password is forwarded to Better Auth and never logged or
 * echoed in the response or audit metadata. The audit row records only
 * the action and target.
 */
const passwordSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("set"),
      password: z.string().min(8).max(128),
    })
    .strict(),
  z
    .object({
      mode: z.literal("reset_email"),
      redirectTo: z.url().optional(),
    })
    .strict(),
]);

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.setPassword");
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
  const parsed = passwordSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (parsed.data.mode === "set") {
    try {
      await setBetterAuthUserPassword(
        {
          userId: target.betterAuthUserId,
          newPassword: parsed.data.password,
        },
        request,
      );
    } catch (err) {
      await auditUserAction("admin.user.password_set_failed", "failure", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        reason: "auth_set_password_failed",
        metadata: { message: err instanceof Error ? err.message : "unknown" },
      });
      return NextResponse.json({ error: "auth_set_password_failed" }, { status: 502 });
    }

    await auditUserAction("admin.user.password_set", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      // metadata intentionally excludes the password.
      metadata: { mode: "set" },
    });
    return NextResponse.json({ ok: true, mode: "set" });
  }

  // mode === "reset_email"
  try {
    await sendBetterAuthPasswordResetEmail(
      target.primaryEmail,
      parsed.data.redirectTo,
      request,
    );
  } catch (err) {
    await auditUserAction("admin.user.password_reset_email_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_forgot_password_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return NextResponse.json({ error: "auth_forgot_password_failed" }, { status: 502 });
  }

  await auditUserAction("admin.user.password_reset_email_sent", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: { mode: "reset_email" },
  });
  return NextResponse.json({ ok: true, mode: "reset_email" });
}
