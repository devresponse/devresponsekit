import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Verify-email landing page.
 *
 * Reached immediately after an email/password sign-up (AUTH-4). Better Auth has
 * emailed a verification link; this "check your inbox" screen delegates to
 * `VerifyEmailPanel`, which — like the pending-approval panel — never invokes
 * the secure shell or secure menu APIs.
 */
export default async function VerifyEmailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <VerifyEmailPanel locale={safeLocale} />
    </main>
  );
}
