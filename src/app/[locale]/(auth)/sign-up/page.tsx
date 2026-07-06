import { SignUpForm, type SignUpInvitation } from "@/components/auth/sign-up-form";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { enabledSocialProviders } from "@/lib/auth";
import { findValidInvitationByToken } from "@/lib/invitations.server";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import { getSafeReturnTo } from "@/lib/safe-return-to";

export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  const rawReturn = typeof sp.returnTo === "string" ? sp.returnTo : null;
  const returnTo = getSafeReturnTo(rawReturn, safeLocale);

  // Invitation-backed sign-up (0008): `?invite=<token>` pre-fills and locks
  // the invited email and threads the token through the sign-up body so the
  // account lands active in the inviting org. An invalid/expired token
  // silently renders the normal form — nothing to leak, nothing to block.
  const inviteToken = typeof sp.invite === "string" && sp.invite.length > 0 ? sp.invite : null;
  let invitation: SignUpInvitation | null = null;
  if (inviteToken) {
    const row = await findValidInvitationByToken(inviteToken);
    if (row) {
      invitation = {
        token: inviteToken,
        email: row.email,
        organizationName: row.organizationName,
      };
    }
  }

  // Organization-scoped sign-up via `?org=<slug|id>`, carried from a scoped
  // sign-in's "create account" link. An invitation's org wins, so only resolve
  // when there is no invitation. Unknown → null (plain screen, no leak).
  const rawOrg = typeof sp.org === "string" ? sp.org : null;
  const organization = !invitation && rawOrg ? await resolveOrganizationByIdentifier(rawOrg) : null;

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 p-8">
      <div className="self-end">
        <LocaleSwitcher current={safeLocale} />
      </div>
      <SignUpForm
        locale={safeLocale}
        returnTo={returnTo}
        invitation={invitation}
        socialProviders={enabledSocialProviders}
        organization={organization}
      />
    </main>
  );
}
