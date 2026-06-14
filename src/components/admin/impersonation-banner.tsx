import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { getCurrentSession } from "@/lib/auth-guard";
import { StopImpersonationButton } from "./impersonation-banner-client";

/**
 * Global "you are impersonating X" banner (docs/admin-manager.md
 * §19 Phase 7, §17 audit posture).
 *
 * Server component: reads the active session and the original actor's
 * email (best effort) so the banner shows "you are impersonating
 * target@x.com" with a "Stop impersonating" client-side button. Renders
 * `null` when no impersonation is active so callers can drop it into
 * any layout without paying for the markup.
 *
 * The "stop" action is a small client component — see
 * {@link StopImpersonationButton}. The cookie clearing is owned by the
 * server endpoint; the client just kicks it off and forces a hard
 * reload to rebuild every cached layer.
 */
export async function ImpersonationBanner() {
  const session = await getCurrentSession();
  if (!session) return null;

  // Better Auth attaches `impersonatedBy` to the session row when an
  // admin has started impersonation. Older / different plugin versions
  // may camelCase or snake_case the field — accept both shapes.
  const sess = (session as unknown as { session?: Record<string, unknown> }).session;
  const impersonatedBy =
    (sess?.impersonatedBy as string | null | undefined) ??
    (sess?.impersonated_by as string | null | undefined) ??
    null;
  if (!impersonatedBy) return null;

  const targetBetterAuthId = (session as unknown as { user: { id: string } }).user.id;
  const targetRow = await db
    .selectFrom("app_users")
    .select(["id", "primary_email"])
    .where("better_auth_user_id", "=", targetBetterAuthId)
    .executeTakeFirst();

  const t = await getTranslations("administrator.users.impersonation");

  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/10 text-warning-foreground flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-sm"
    >
      <span>{t("bannerLabel", { email: targetRow?.primary_email ?? targetBetterAuthId })}</span>
      <StopImpersonationButton
        targetAppUserId={targetRow?.id ?? null}
        label={t("stopButton")}
        errorLabel={t("stopErrorToast")}
      />
    </div>
  );
}
