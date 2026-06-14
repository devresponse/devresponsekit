import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/email/templates
 *
 * Lists every editable email template (specs.md §35). The catalog is
 * small and bounded (a handful of keys × locales) so this endpoint
 * returns the full set without pagination. Bodies are included so the
 * editor can load from the list response.
 *
 * Caller MUST hold `admin.email.read`. The template catalog is platform-
 * global config (identical for every tenant and has no organization column),
 * so reading it is not a cross-tenant leak — any admin reader may view it.
 * Editing a template (PUT [id]) affects every tenant and is SUPERADMIN-only.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.email.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const items = await db
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
    .orderBy("key", "asc")
    .orderBy("locale", "asc")
    .execute();

  return NextResponse.json({ items });
}
