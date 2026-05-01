import { BlockedAccountPanel } from "@/components/auth/blocked-account-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Blocked / suspended / deactivated landing page.
 *
 * Reached when the application user record exists but the status forbids
 * secure access. Delegates rendering to `BlockedAccountPanel` so the
 * panel can be reused in tests and any future surface (e.g. admin
 * preview).
 */
export default async function BlockedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <BlockedAccountPanel locale={safeLocale} />
    </main>
  );
}
