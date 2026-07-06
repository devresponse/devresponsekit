import { EmailVerifiedPanel } from "@/components/auth/email-verified-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Email-verified confirmation page.
 *
 * Where the email-verification link lands now that
 * `autoSignInAfterVerification` is off (auth.ts): the address is confirmed but
 * no session was created, so this public screen confirms success and offers an
 * explicit "proceed to login" step. Delegates to `EmailVerifiedPanel`, which —
 * like the other pre-auth panels — never invokes the secure shell.
 */
export default async function VerifyEmailConfirmedPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <EmailVerifiedPanel locale={safeLocale} />
    </main>
  );
}
