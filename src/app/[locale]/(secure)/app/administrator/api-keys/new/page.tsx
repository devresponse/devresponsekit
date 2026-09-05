import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";
import { NewApiKeyForm } from "./_new-api-key-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/api-keys/new
 *
 * Server entry for the issue-on-behalf form (docs/admin-manager.md
 * §8.8). Gated on `admin.apikeys.manage`. The scope catalog is passed
 * down from the server so the client never imports the `server-only`
 * permission graph; the server route re-validates every scope against
 * BOTH the owner's authority and the acting admin's own permissions /
 * granted scopes (`ungrantableScopesForCaller`, P0-2) regardless.
 */
export default async function AdministratorNewApiKeyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.apikeys.manage");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.apiKeys" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>
      <NewApiKeyForm locale={locale} scopeCatalog={[...API_SCOPE_CATALOG]} />
    </section>
  );
}
