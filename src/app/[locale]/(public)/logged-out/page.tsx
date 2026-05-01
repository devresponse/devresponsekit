import { LoggedOutPanel } from "@/components/auth/logged-out-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Localized logged-out page.
 *
 * Reached by `SignOutButton` after the local-only sign-out completes.
 * Lives under the `(public)` group so it never re-engages the secure
 * shell or hits secure menu APIs. Delegates rendering to
 * `LoggedOutPanel`.
 */
export default async function LoggedOutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <LoggedOutPanel locale={safeLocale} />
    </main>
  );
}
