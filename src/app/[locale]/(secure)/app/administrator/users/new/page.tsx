import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { NewUserForm } from "./_new-user-form";

export const dynamic = "force-dynamic";

/**
 * Administrator → New user page (docs/admin-manager.md §8.3).
 *
 * RSC entry point that gates on `admin.users.create` and renders a
 * client-side form (`NewUserForm`). The form `POST`s to
 * `/api/administrator/users` which performs the Better Auth + app
 * insert in a single transaction.
 */
export default async function AdministratorNewUserPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  const guard = await checkAdminPermissionServer("admin.users.create");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.users" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <Button asChild variant="link" className="h-auto px-0 text-sm">
          <LocaleLink locale={locale} href="/app/administrator/users">
            ← {t("detail.backToList")}
          </LocaleLink>
        </Button>
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>

      <NewUserForm locale={locale} />
    </section>
  );
}
