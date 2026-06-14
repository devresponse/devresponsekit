import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { sendAppEmail } from "@/lib/email/send.server";

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
 */
const testSchema = z
  .object({
    to: z.email(),
  })
  .strict();

export async function POST(request: NextRequest) {
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

  const limited = enforceRateLimit(
    "admin.email.test",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
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

  const result = await sendAppEmail({
    to: parsed.data.to,
    templateKey: "test_email",
    organizationId,
    variables: {
      appName: process.env.NEXT_PUBLIC_APP_NAME ?? "DevResponse",
      sentBy: guard.betterAuthUserId,
    },
  });

  await auditEvent({
    eventType: "admin.email.test_sent",
    outcome: result.status === "failed" ? "error" : "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    email: parsed.data.to,
    request,
    metadata: { outboxId: result.outboxId, status: result.status },
  });

  return NextResponse.json({ ok: result.status !== "failed", ...result });
}
