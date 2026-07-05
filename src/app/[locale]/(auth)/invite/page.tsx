import {
  InviteAcceptPanel,
  InviteGuestPanel,
  InviteInvalidPanel,
  InviteMismatchPanel,
} from "@/components/auth/invite-panels";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { getCurrentSession } from "@/lib/auth-guard";
import { findValidInvitationByToken } from "@/lib/invitations.server";

export const dynamic = "force-dynamic";

/**
 * /[locale]/invite?token=…
 *
 * The invitation accept page (0008). All branching happens server-side:
 *
 *   - token missing/unknown/expired/revoked/consumed → one generic invalid
 *     panel (no organization details leak to token guessers);
 *   - live token, no session → org name + create-account / sign-in CTAs
 *     (sign-up carries the token; sign-in returns here);
 *   - live token, session with a DIFFERENT email → mismatch panel with a
 *     sign-out affordance (the invited address is never echoed);
 *   - live token, matching session → explicit accept (POST
 *     /api/invitations/accept).
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  const token = typeof sp.token === "string" && sp.token.length > 0 ? sp.token : null;

  const invitation = token ? await findValidInvitationByToken(token) : null;

  let panel: React.ReactNode;
  if (!invitation || !token) {
    panel = <InviteInvalidPanel />;
  } else {
    const session = await getCurrentSession();
    if (!session) {
      panel = (
        <InviteGuestPanel
          locale={safeLocale}
          organizationName={invitation.organizationName}
          token={token}
        />
      );
    } else if (session.user.email.trim().toLowerCase() !== invitation.email) {
      panel = <InviteMismatchPanel locale={safeLocale} />;
    } else {
      panel = (
        <InviteAcceptPanel
          locale={safeLocale}
          organizationName={invitation.organizationName}
          email={invitation.email}
          token={token}
        />
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 p-8">
      <div className="self-end">
        <LocaleSwitcher current={safeLocale} />
      </div>
      {panel}
    </main>
  );
}
