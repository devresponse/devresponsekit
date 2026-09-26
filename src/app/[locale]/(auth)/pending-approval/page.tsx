import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { PendingApprovalPanel } from "@/components/auth/pending-approval-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/** The impersonation banner reads the session, so this page is per request. */
export const dynamic = "force-dynamic";

/**
 * Pending approval landing page.
 *
 * Reached when a non-seed user has signed in but has not been approved
 * by an administrator. Delegates rendering to `PendingApprovalPanel`
 * which guarantees the secure shell and secure menu APIs are not
 * invoked (spec §13).
 *
 * F-148: an IMPERSONATED session lands here too when, while the admin is using
 * it, the borrowed identity is left with no active membership in the
 * impersonator's reach (removed, or pending again), or the impersonator's own
 * reach shrinks to nothing. This page is outside the `(secure)` group, so it
 * renders the impersonation banner itself: its Stop control is the admin's way
 * back to their own session, where Sign out would end the borrowed session
 * without restoring theirs. The banner renders nothing for an ordinary session.
 */
export default async function PendingApprovalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <>
      <ImpersonationBanner />
      <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
        <PendingApprovalPanel locale={safeLocale} />
      </main>
    </>
  );
}
