import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { hasCrossOrgReach, resolveOrgScope } from "@/lib/admin/access-scope.server";
import {
  ADMIN_MAIL_EVENTS,
  ADMIN_TEST_EMAIL_LIMIT,
  enforceOrgAdminMailBudget,
} from "@/lib/admin/admin-mail-budget.server";
import { enforceSharedRateLimit } from "@/lib/admin/rate-limit-shared.server";
import { refuseWithoutCrossOrgReach } from "@/lib/admin/refusals.server";
import { sendAppEmail } from "@/lib/email/send.server";
import { humanActorId } from "@/lib/impersonation-attribution.server";
import { getBrand } from "@/config/brand";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/administrator/email/test
 *
 * Sends the `test_email` template to the given address through the full
 * outbox pipeline (specs.md §35) — the canonical way to verify provider
 * configuration. With no provider configured the email is recorded as
 * `logged`, which still proves rendering + outbox wiring end to end.
 *
 * Caller MUST hold `admin.email.manage`. Audited with the outcome of
 * the delivery attempt.
 *
 * F-64: only a caller with cross-org reach (a superadmin session) picks the
 * recipient. Anyone else may mail only their own account's address (403
 * `forbidden` and a denied row otherwise), and their test emails count toward
 * their organization's daily admin-mail budget. The per-actor budget
 * (`ADMIN_TEST_EMAIL_LIMIT`, 10 an hour) comes from the shared bucket.
 */
const testSchema = z
  .object({
    to: z.email(),
  })
  .strict();

export const POST = withAdminRoute(async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.email.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: attribute the test email to the sender's tenant so it lands in
  // their own org-scoped outbox view. An ORG ADMIN → their org; a SUPERADMIN
  // → null (a platform/system test). A null scope cannot send.
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return adminErrorResponse("forbidden", 403, request);
  }
  const organizationId = scope.kind === "org" ? scope.organizationId : null;

  // F-64: from the SHARED bucket. Kept per process, the budget multiplied by
  // the instance count, and every token here is a mail from the platform.
  const limited = await enforceSharedRateLimit(
    "admin.email.test",
    guard.betterAuthUserId,
    ADMIN_TEST_EMAIL_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = testSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // F-64: choosing the recipient is a platform-operator capability. An org
  // admin (or an org-bound credential) sends to the address its own account
  // signs in with, which nobody can edit afterwards, so the test email can
  // prove their tenant's mail works without mailing a stranger.
  const ownAddress = guard.access.primaryEmail?.trim().toLowerCase() ?? null;
  if (!hasCrossOrgReach(guard.access) && parsed.data.to.trim().toLowerCase() !== ownAddress) {
    return refuseWithoutCrossOrgReach(
      guard,
      request,
      "email_test_recipient",
      undefined,
      parsed.data.to,
    );
  }
  const overBudget = await enforceOrgAdminMailBudget(guard, organizationId, request);
  if (overBudget) return overBudget;

  const result = await sendAppEmail({
    to: parsed.data.to,
    templateKey: "test_email",
    organizationId,
    variables: {
      appName: getBrand().name,
      // F-07: the human behind an impersonated session, matching the audit row.
      sentBy: humanActorId(guard),
    },
  });

  // `failed` = the provider rejected the send permanently (a non-retryable
  // 4xx — review #219). That is the outcome this endpoint exists to surface:
  // a misconfigured sending domain or API key. `pending` means the attempt
  // failed transiently and the outbox worker owns it from here, so it is not
  // an error of this request. (Before #219 `failed` was unreachable and these
  // branches were dead — review #235.)
  await auditEvent({
    eventType: ADMIN_MAIL_EVENTS.testEmail,
    outcome: result.status === "failed" ? "error" : "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    // F-32: the same tenant the outbox row is attributed to above.
    organizationId,
    email: parsed.data.to,
    request,
    metadata: { outboxId: result.outboxId, status: result.status },
  });

  return NextResponse.json({ ok: result.status !== "failed", ...result });
});
