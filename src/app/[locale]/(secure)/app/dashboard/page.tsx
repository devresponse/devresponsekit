import { useTranslations } from "next-intl";

/**
 * Secure dashboard placeholder.
 *
 * Renders inside the secure shell. Content is intentionally minimal —
 * the integration work for this scaffold focuses on the shell, auth,
 * navigation, and SSO layers; the dashboard widgets are out of scope.
 */
export default function DashboardPage() {
  const t = useTranslations("shell");
  return (
    <section className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("dashboard")}</h1>
      <p className="text-muted-foreground text-sm">
        Welcome to the secure DevResponse Enterprise shell.
      </p>
    </section>
  );
}
