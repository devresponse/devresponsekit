import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import {
  sendBetterAuthPasswordResetEmail,
  setBetterAuthUserPassword,
} from "@/lib/admin/auth-admin.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import {
  ADMIN_MAIL_EVENTS,
  enforceOrgAdminMailBudget,
  enforceRecipientCooldown,
} from "@/lib/admin/admin-mail-budget.server";
import { refuseSharedTarget } from "@/lib/admin/refusals.server";
import {
  isAgentServiceAccount,
  SERVICE_ACCOUNT_ERROR,
  SERVICE_ACCOUNT_STATUS,
} from "@/lib/admin/service-account";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/password
 *
 * Two modes (docs/admin-manager.md §8.1):
 *   - `mode: "set"`     — admin sets a new password directly. This also
 *                         ends every session of the user's and revokes the
 *                         API keys and OAuth clients that act as them
 *                         (F-08, F-10).
 *   - `mode: "reset_email"` — triggers a password-reset email via
 *                             Better Auth's `requestPasswordReset`
 *                             (`sendBetterAuthPasswordResetEmail`). F-64:
 *                             one per user per 10 minutes, and an
 *                             org-confined caller spends the org's daily
 *                             admin-mail budget (429 `rate_limited`).
 *
 * The new password is forwarded to Better Auth and never logged or
 * echoed in the response or audit metadata. The audit row records only
 * the action and target. An agent service account has no password: 409
 * `not_applicable_to_service_account` in both modes (F-77).
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

export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
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

  // Privilege ordering (review #7): a non-SUPERADMIN may not touch the
  // credential of a target who outranks them — a single-org superadmin passes
  // the shared-target test below, so this check is what stops an org admin
  // from setting a superadmin's password and signing in with global
  // authority. It runs BEFORE the body is parsed, for BOTH modes: a reset
  // email on an out-ranking target is the first hop of a two-request chain
  // (trigger the reset, read the live link from the email outbox with
  // `admin.email.read`, set the password), and a superadmin can self-serve a
  // reset from the sign-in page, so nothing is lost by gating it. 403 + audit.
  const outranked = await refuseOutrankingTarget(guard, target, request, "password");
  if (outranked) return outranked;

  // F-77: an agent service account signs in with client credentials only. It
  // has no Better Auth user to set a password on (a 502), and its `.invalid`
  // address receives no reset email, which was still reported sent and
  // charged to the mail budget. Both modes refuse it.
  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }

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
    // a recovery flow the user completes themselves, so it isn't gated here;
    // the rank guard above applies to both modes.)
    const scope = resolveOrgScope(guard.access);
    if (!scope) return adminErrorResponse("not_found", 404, request);
    if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
      return refuseSharedTarget(guard, target, request, "password");
    }

    // F-10: a new password also signs the user out everywhere and revokes the
    // API keys and OAuth clients that act as them. That happens inside the
    // wrapper, in the actor's name, so a failure there lands in the 502 below
    // and the operator retries.
    try {
      await setBetterAuthUserPassword(
        {
          userId: target.betterAuthUserId,
          newPassword: parsed.data.password,
          setBy: {
            betterAuthUserId: guard.betterAuthUserId,
            appUserId: guard.access.appUserId,
            requestId: guard.requestId,
          },
        },
        request,
      );
    } catch (err) {
      await auditUserAction("admin.user.password_set_failed", "failure", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        organizationId: actingOrganizationId(guard.access),
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
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      // metadata intentionally excludes the password.
      metadata: { mode: "set" },
    });
    return NextResponse.json({ ok: true, mode: "set" });
  }

  // mode === "reset_email"
  // F-64: the same mail cannon as the test email and an invitation resend. An
  // org admin reaches any address by creating a member with it, and the
  // per-actor bucket let them mail it once a second. The daily budget is only
  // read, so it goes first; the cooldown spends this user's token.
  const overBudget = await enforceOrgAdminMailBudget(
    guard,
    actingOrganizationId(guard.access),
    request,
  );
  if (overBudget) return overBudget;
  const cooling = await enforceRecipientCooldown(
    "admin.users.password.reset_email",
    target.appUserId,
    guard,
    request,
  );
  if (cooling) return cooling;

  try {
    await sendBetterAuthPasswordResetEmail(target.primaryEmail, parsed.data.redirectTo, request);
  } catch (err) {
    await auditUserAction("admin.user.password_reset_email_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      reason: "auth_forgot_password_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_forgot_password_failed", 502, request, { cause: err });
  }

  await auditUserAction(ADMIN_MAIL_EVENTS.passwordResetEmail, "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    metadata: { mode: "reset_email" },
  });
  return NextResponse.json({ ok: true, mode: "reset_email" });
});
