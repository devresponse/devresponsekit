import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { BlockedAccountPanel } from "@/components/auth/blocked-account-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/** The impersonation banner reads the session, so this page is per request. */
export const dynamic = "force-dynamic";

/**
 * Blocked / suspended / deactivated landing page.
 *
 * Reached when the application user record exists but the status forbids
 * secure access. Delegates rendering to `BlockedAccountPanel` so the
 * panel can be reused in tests and any future surface (e.g. admin
 * preview).
 *
 * F-148: an IMPERSONATED session lands here too when the borrowed identity, or
 * its only membership in the impersonator's reach, is blocked or suspended
 * while the admin is using it. This page is outside the `(secure)` group, so it
 * renders the impersonation banner itself: its Stop control is the admin's way
 * back to their own session, where Sign out would end the borrowed session
 * without restoring theirs. The banner renders nothing for an ordinary session.
 */
export default async function BlockedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <>
      <ImpersonationBanner />
      <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
        <BlockedAccountPanel locale={safeLocale} />
      </main>
    </>
  );
}
