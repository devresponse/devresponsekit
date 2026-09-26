import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { mayCreateUser, type CreationCaller } from "@/lib/admin/user-create.server";
import { NewUserForm } from "./_new-user-form";

export const dynamic = "force-dynamic";

/**
 * Administrator → New user page (docs/admin-manager.md §8.1).
 *
 * RSC entry point that gates on `admin.users.create` and renders a
 * client-side form (`NewUserForm`). The form `POST`s to
 * `/api/administrator/users`, which creates the Better Auth user and then
 * inserts the `app_users` row as a second, non-transactional step (a
 * duplicate-email race maps to 409 and leaves the auth user behind for
 * reconciliation — review #33/#136).
 *
 * The guard key stays `admin.users.create`, the key of the nav link and of the
 * users list's New user button. A caller confined to one org that also lacks a
 * membership permission passes it, but the API refuses every create it could
 * submit (F-480), so the page shows it why in place of the form.
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
  // This page is always a cookie session, so the caller carries no credential
  // scopes: only its permissions limit it.
  const caller: CreationCaller = { access: guard.access, grantedScopes: null };

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>

      {/* The Better Auth `admin` role is offered only to a caller the API lets
          mint it (F-13, the same predicate as `POST /api/administrator/users`),
          and each initial status only to one the API lets create it (F-480,
          the predicate `refuseConfinedCreation` applies). */}
      {mayCreateUser(caller, "pending_approval") ? (
        <NewUserForm
          locale={locale}
          canGrantPlatformAdmin={hasCrossOrgReach(guard.access)}
          canCreateActive={mayCreateUser(caller, "active")}
        />
      ) : (
        <Alert variant="warning" role="note">
          <AlertDescription>{t("new.enrolmentNotPermitted")}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
