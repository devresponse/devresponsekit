import { PendingApprovalPanel } from "@/components/auth/pending-approval-panel";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Pending approval landing page.
 *
 * Reached when a non-seed user has signed in but has not been approved
 * by an administrator. Delegates rendering to `PendingApprovalPanel`
 * which guarantees the secure shell and secure menu APIs are not
 * invoked (spec §13).
 */
export default async function PendingApprovalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <PendingApprovalPanel locale={safeLocale} />
    </main>
  );
}
