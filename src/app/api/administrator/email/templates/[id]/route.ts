import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.uuid();

/**
 * GET /api/administrator/email/templates/[id]
 *
 * Single template for the editor. Caller MUST hold `admin.email.read`.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.email.read");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: email templates are platform-global config — SUPERADMIN-only.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return adminErrorResponse("not_found", 404, request);
  }

  const template = await db
    .selectFrom("app_email_templates")
    .select([
      "id",
      "key",
      "locale",
      "subject",
      "body_html",
      "body_text",
      "description",
      "created_at",
      "updated_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!template) {
    return adminErrorResponse("not_found", 404, request);
  }
  return NextResponse.json(template);
}

/**
 * PUT /api/administrator/email/templates/[id]
 *
 * Updates the editable fields of a template (specs.md §35). `key` and
 * `locale` are immutable — they are the identity flows send against;
 * renaming would silently detach the flow from its template.
 *
 * Caller MUST hold `admin.email.manage`. Audited as
 * `admin.email.template_updated` (subjects/bodies are not echoed into
 * audit metadata — the template row itself is the record).
 */
const updateSchema = z
  .object({
    subject: z.string().min(1).max(500),
    body_html: z.string().min(1).max(100_000),
    body_text: z.string().max(100_000).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
  })
  .strict();

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.email.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: editing a platform-global template is SUPERADMIN-only.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const limited = enforceRateLimit(
    "admin.email.templates",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return adminErrorResponse("not_found", 404, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const updated = await db
    .updateTable("app_email_templates")
    .set({
      subject: parsed.data.subject,
      body_html: parsed.data.body_html,
      body_text: parsed.data.body_text ?? null,
      description: parsed.data.description ?? null,
      updated_at: sql`now()`,
    })
    .where("id", "=", id)
    .returning(["id", "key", "locale"])
    .executeTakeFirst();

  if (!updated) {
    return adminErrorResponse("not_found", 404, request);
  }

  await auditEvent({
    eventType: "admin.email.template_updated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    request,
    metadata: { templateId: updated.id, key: updated.key, locale: updated.locale },
  });

  return NextResponse.json({ ok: true, id: updated.id });
}
