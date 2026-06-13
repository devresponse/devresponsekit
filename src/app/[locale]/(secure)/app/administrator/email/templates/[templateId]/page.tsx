import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { db } from "@/db/database";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { getDefaultEmailTemplate } from "@/lib/email/templates";
import { TemplateEditForm } from "./_template-edit-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/email/templates/[templateId]
 *
 * Standard edit page for one email template (specs.md §35), following
 * the new-record form pattern: server gate + client form, submit and
 * Cancel at the bottom, no back link. `key` and `locale` are shown but
 * immutable — flows send against the key.
 *
 * Caller MUST hold `admin.email.manage`.
 */
export default async function AdministratorEmailTemplateEditPage({
  params,
}: {
  params: Promise<{ locale: string; templateId: string }>;
}) {
  const { locale, templateId } = await params;
  const guard = await checkAdminPermissionServer("admin.email.manage");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!z.uuid().safeParse(templateId).success) {
    notFound();
  }

  const template = await db
    .selectFrom("app_email_templates")
    .select(["id", "key", "locale", "subject", "body_html", "body_text", "description"])
    .where("id", "=", templateId)
    .executeTakeFirst();
  if (!template) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.email.templates" });
  const knownVariables = getDefaultEmailTemplate(template.key)?.variables ?? [];

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("editTitle")}</h1>
        <p className="text-muted-foreground text-sm">
          <code className="text-xs">{template.key}</code> ·{" "}
          <span className="uppercase">{template.locale}</span>
        </p>
      </div>

      <TemplateEditForm
        locale={locale}
        template={{
          id: template.id,
          subject: template.subject,
          body_html: template.body_html,
          body_text: template.body_text,
          description: template.description,
        }}
        knownVariables={knownVariables}
      />
    </section>
  );
}
