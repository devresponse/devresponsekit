import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  sendBetterAuthPasswordResetEmail,
  setBetterAuthUserPassword,
} from "@/lib/admin/auth-admin.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
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

  const limited = enforceRateLimit(
    "admin.users.password",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = passwordSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  if (parsed.data.mode === "set") {
    // AUTHZ-2: directly setting a password is account-global — it grants a
    // credential usable in EVERY org the user belongs to. For a user shared
    // across tenants, that's SUPERADMIN-only; an org admin may only set the
    // password of a user confined to their own org. (The reset-email mode is
    // a recovery flow the user completes themselves, so it isn't gated here.)
    //
    // Privilege ordering (review #7): a non-SUPERADMIN may not mint a
    // credential for a target who outranks them — a single-org superadmin
    // passes the shared-target test below, so this check is what stops an
    // org admin from setting a superadmin's password and signing in with
    // global authority. 403 + audit.
    const outranked = await refuseOutrankingTarget(guard, target, request, "password_set");
    if (outranked) return outranked;

    const scope = resolveOrgScope(guard.access);
    if (!scope) return adminErrorResponse("not_found", 404, request);
    if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
      return adminErrorResponse("forbidden", 403, request);
    }

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
      return adminErrorResponse("auth_set_password_failed", 502, request, { cause: err });
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
    await sendBetterAuthPasswordResetEmail(target.primaryEmail, parsed.data.redirectTo, request);
  } catch (err) {
    await auditUserAction("admin.user.password_reset_email_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_forgot_password_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_forgot_password_failed", 502, request, { cause: err });
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
