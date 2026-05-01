import { getTranslations } from "next-intl/server";
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
  const users = await db
    .selectFrom("app_users")
    .select(["id", "primary_email", "status"])
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">{t("users")}</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="px-2 py-1">Email</th>
            <th className="px-2 py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-shell-border border-t">
              <td className="px-2 py-1">{u.primary_email}</td>
              <td className="px-2 py-1">{u.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
