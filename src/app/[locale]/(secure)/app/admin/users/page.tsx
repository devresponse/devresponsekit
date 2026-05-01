import { getTranslations } from "next-intl/server";
import { AdminUsersConsole } from "@/components/admin/admin-users-console";
import { db } from "@/db/database";

export const dynamic = "force-dynamic";

/**
 * Admin users page (placeholder).
 *
 * Real implementation gates behind `admin.users.manage` permission via
 * the secure layout's access context. This scaffold renders the latest
 * pending users so the integration tests in §29.6 have a UI surface to
 * approve against.
 */
export default async function AdminUsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shell" });
  const appUsers = await db
    .selectFrom("app_users")
    .select(["better_auth_user_id", "status"])
    .execute();

  const appStatusByAuthUserId = Object.fromEntries(
    appUsers.map((user) => [user.better_auth_user_id, user.status]),
  );

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">{t("users")}</h1>
      <AdminUsersConsole appStatusByAuthUserId={appStatusByAuthUserId} />
    </section>
  );
}
