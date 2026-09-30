import "server-only";
import { sql } from "kysely";
import { defaultLocale, isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { db } from "@/db/database";

/**
 * F-102 — the language of a mail an administrator action sends: the test
 * email, and an invitation's create and resend. All three used to go out in
 * the default locale (English, with an `/en/` invitation link), so the
 * translated `organization_invitation` and `test_email` templates were never
 * picked. The admin's reset email is not one of them: Better Auth sends it for
 * an account, and `sendAppEmail` reads that account's `preferred_locale`.
 *
 * In order, the first that names a supported locale:
 *   1. The recipient's own `preferred_locale`, when the address belongs to an
 *      account here (matched case-insensitively, as the invitation routes'
 *      member check matches it) that the mail's readers can already see. The
 *      outbox row belongs to `organizationId`, and that org's admins read it,
 *      so the account must hold a membership there, in any status (the reach
 *      `canAccessUser` counts). A `null` org is a platform row, which only an
 *      admin with cross-org reach reads, so any account counts. A pending
 *      member's invitation, and the test email an admin sends to their own
 *      address, read like the rest of their mail.
 *   2. The locale of the page the admin sent it from. The console's
 *      same-origin `fetch` carries that page's URL as `Referer` under the
 *      app's `strict-origin-when-cross-origin` policy. Nothing else is known
 *      about a new invitee, and the admin is working in this language.
 *   3. The sending account's own `preferred_locale`: a bearer credential has
 *      no page.
 *   4. The default locale.
 *
 * Why step 1 stops at the org: `preferred_locale` is never null, so an
 * unconfined lookup settled the language of every account on the platform.
 * The inviting org's admins would then read in the outbox row whether an
 * address has an account in some other organization, and which language it
 * chose, although existence is never leaked across tenants
 * (docs/architecture.md). Confined, an account outside the org gets the same
 * answer as no account. The cost: an invitee whose account belongs only to
 * other orgs is written to in the admin's language, not their own.
 *
 * A forged `Referer` or an odd stored value can choose among the supported
 * locales and nothing else.
 */
export async function adminMailLocale(
  recipient: string,
  organizationId: string | null,
  request: { headers: Headers },
  sender: { preferredLocale: string },
): Promise<SupportedLocale> {
  let lookup = db
    .selectFrom("app_users as u")
    .select("u.preferred_locale")
    .where(sql`lower(u.primary_email)`, "=", recipient.trim().toLowerCase());
  // Users have no org column; their tenant is their membership.
  if (organizationId !== null) {
    lookup = lookup.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_organization_memberships as m")
          .select("m.id")
          .whereRef("m.app_user_id", "=", "u.id")
          .where("m.organization_id", "=", organizationId),
      ),
    );
  }
  const account = await lookup.executeTakeFirst();
  if (account && isSupportedLocale(account.preferred_locale)) return account.preferred_locale;
  const page = pageLocale(request.headers.get("referer"));
  if (page) return page;
  return isSupportedLocale(sender.preferredLocale) ? sender.preferredLocale : defaultLocale;
}

/** The locale segment of a page URL (`https://host/ja/app/…` → `ja`), if any. */
function pageLocale(referer: string | null): SupportedLocale | undefined {
  if (!referer) return undefined;
  let segment: string | undefined;
  try {
    segment = new URL(referer).pathname.split("/")[1];
  } catch {
    return undefined;
  }
  return isSupportedLocale(segment) ? segment : undefined;
}
