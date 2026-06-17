import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { PermissionsCard } from "./_components/permissions-card";
import { getAccountOverview } from "./_data.server";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/account
 *
 * Account overview — a READ-ONLY summary so a user can "view all of my
 * information" at a glance. Status, organization memberships, and roles
 * are admin-controlled and therefore display-only here; the editable
 * areas live in the Profile / Preferences / Security sections. Scoped
 * entirely to the caller's own record (`access.appUserId`).
 */
function statusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (status === "active") return "secondary";
  if (status === "blocked" || status === "suspended" || status === "deactivated") {
    return "destructive";
  }
  return "outline";
}

export default async function AccountOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/account`);

  if (!access.appUserId) notFound();
  const overview = await getAccountOverview(access.appUserId);
  if (!overview) notFound();

  const t = await getTranslations({ locale, namespace: "account" });
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "long" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sections.overview.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sections.overview.description")}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("overview.identity")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
              <Field label={t("fields.displayName")}>{overview.displayName ?? "—"}</Field>
              <Field label={t("fields.email")}>{overview.primaryEmail}</Field>
              <Field label={t("overview.status")}>
                <Badge variant={statusVariant(overview.status)}>
                  {t(`status.${overview.status}` as Parameters<typeof t>[0])}
                </Badge>
              </Field>
              <Field label={t("overview.memberSince")}>
                {dateFormatter.format(new Date(overview.createdAt))}
              </Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("overview.memberships")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.memberships.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("overview.noMemberships")}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {overview.memberships.map((m) => (
                  <li key={m.organizationId} className="flex items-center justify-between gap-2">
                    <span>{m.organizationName}</span>
                    <Badge variant={statusVariant(m.status)}>
                      {t(`status.${m.status}` as Parameters<typeof t>[0])}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("overview.roles")}
              </p>
              {overview.roles.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("overview.noRoles")}</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {overview.roles.map((role) => (
                    <Badge key={role} variant="outline">
                      {role}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <PermissionsCard
        permissions={access.permissions}
        title={t("overview.permissions")}
        description={t("overview.permissionsDescription")}
        emptyLabel={t("overview.noPermissions")}
      />
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="col-span-2 text-sm break-all">{children}</dd>
    </>
  );
}
