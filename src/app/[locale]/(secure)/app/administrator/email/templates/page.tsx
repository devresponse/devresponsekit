import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { isSupportedLocale } from "@/config/i18n-config";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { getAppFormatter } from "@/lib/format/viewer-format.server";
import { EmailTemplateFilters } from "./_template-filters";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/email/templates
 *
 * Editable email-template catalog (specs.md §35). The set is small and
 * bounded (template keys × locales), so this page server-renders the
 * full list directly from the database — no client grid needed. Each
 * row links to the standard edit page.
 *
 * Two URL-backed filters narrow the list: template type (`key`) and
 * `locale`, each with an "All" option. The dropdown options come from the
 * keys/locales that actually exist, so they never go stale; unrecognized
 * query values are ignored (treated as "All"). Filtering happens in the
 * database query — the URL is the single source of truth, matching the
 * grid filter convention (docs/admin-manager.md §10).
 *
 * Caller MUST hold `admin.email.read`. Editing a template is SUPERADMIN-only
 * (the catalog is platform-global and the PUT enforces it), so the Edit link
 * is shown only to a SUPERADMIN — review #73: gating it on `admin.email.manage`
 * pointed permitted org admins at a form that always 403d on save.
 */
export default async function AdministratorEmailTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ key?: string; locale?: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.email.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  // Review #73 + #75: the Edit link must match the edit page's guard, which
  // matches the SUPERADMIN-only PUT. Derived from the guard we already hold —
  // a second checkAdminPermissionServer() would be another session + access
  // round-trip for an answer this context already carries.
  const canManage = isSuperadmin(guard.access);

  const t = await getTranslations({ locale, namespace: "administrator.email.templates" });
  const tGrid = await getTranslations({ locale, namespace: "administrator.grid" });
  // F-37: "Updated" was the UTC ISO string cut to minutes, with no zone
  // marker, so it read as local time. It now shows the viewer's zone and format.
  const format = await getAppFormatter(locale);

  // Filter-option lists come from the templates that actually exist, so the
  // dropdowns never offer a value that yields nothing (and never omit one
  // that would). Two lightweight DISTINCT queries over a tiny table.
  const [keyRows, localeRows] = await Promise.all([
    db.selectFrom("app_email_templates").select("key").distinct().orderBy("key", "asc").execute(),
    db
      .selectFrom("app_email_templates")
      .select("locale")
      .distinct()
      .orderBy("locale", "asc")
      .execute(),
  ]);
  const keyOptions = keyRows.map((r) => r.key);
  const localeOptions = localeRows.map((r) => r.locale);

  // Validate the requested filters against what exists / is supported;
  // anything else is silently treated as "All" (no filter).
  const requested = await searchParams;
  const activeKey = requested.key && keyOptions.includes(requested.key) ? requested.key : null;
  const activeLocale =
    requested.locale &&
    isSupportedLocale(requested.locale) &&
    localeOptions.includes(requested.locale)
      ? requested.locale
      : null;

  let query = db
    .selectFrom("app_email_templates")
    .select(["id", "key", "locale", "subject", "description", "updated_at"]);
  if (activeKey) query = query.where("key", "=", activeKey);
  if (activeLocale) query = query.where("locale", "=", activeLocale);
  const templates = await query.orderBy("key", "asc").orderBy("locale", "asc").execute();

  const hasActiveFilter = activeKey !== null || activeLocale !== null;

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <EmailTemplateFilters
        keyOptions={keyOptions}
        localeOptions={localeOptions}
        activeKey={activeKey}
        activeLocale={activeLocale}
      />

      <div className="rounded-lg border">
        <Table containerLabel={t("title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.key")}</TableHead>
              <TableHead>{t("columns.locale")}</TableHead>
              <TableHead>{t("columns.subject")}</TableHead>
              <TableHead>{t("columns.updatedAt")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-sm">
                  {hasActiveFilter ? tGrid("empty") : t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <code className="text-xs">{template.key}</code>
                  </TableCell>
                  <TableCell className="text-xs uppercase">{template.locale}</TableCell>
                  <TableCell className="text-sm">{template.subject}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {format.dateTime(template.updated_at as unknown as string | Date)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage ? (
                      <Button asChild size="sm" variant="outline">
                        <LocaleLink
                          href={`/app/administrator/email/templates/${template.id}` as "/"}
                          locale={locale}
                        >
                          {t("edit")}
                        </LocaleLink>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
