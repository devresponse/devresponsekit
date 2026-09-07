import "server-only";
import { isBanActive } from "@/lib/ban-status";

/**
 * Returns true when the given Better Auth user is currently banned.
 *
 * Why this exists: the machine-API credential paths (API keys, JWT access
 * tokens) authorize off `app_users.status` via `getUserAccessContext`,
 * which does NOT reflect a Better Auth ban. The standalone admin ban action
 * (`auth.api.banUser`) only sets the Better Auth `banned` flag — it does not
 * touch `app_users.status` — so without this check a banned user's
 * previously issued API keys and access tokens would keep authenticating
 * against `/api/v1` indefinitely (API keys can be issued with no expiry)
 * even though their browser sessions are revoked. See AUTH-1.
 *
 * We consult the very same `banned` flag the SSO session plugin already
 * treats as authoritative (`auth-sso-session.ts`), through the very same
 * predicate ({@link isBanActive}, review #126), so a single source of ban
 * truth is preserved and an `unban` automatically restores machine access
 * with no extra revocation bookkeeping.
 *
 * Honors a temporary ban's expiry: an elapsed `banExpires` is treated as
 * not-banned, mirroring Better Auth's own sign-in behavior. Unknown users
 * return `false` here — distinguishing "no such user" from "banned" is the
 * resolver's job (a credential for a missing user fails elsewhere).
 */
/** The two ban columns Better Auth's admin plugin maintains on the user row. */
type BannableUserRow = { banned?: boolean | null; banExpires?: Date | string | null };

export async function isBetterAuthUserBanned(betterAuthUserId: string): Promise<boolean> {
  // Lazy import so the heavy Better Auth instance — which eagerly reads
  // `pgPool` at module load (auth.ts) — stays OUT of the static import graph
  // of every /api/v1 and admin route that transitively pulls in the caller
  // resolver. It is constructed only when a bearer credential is actually
  // being resolved at runtime.
  const { auth } = await import("@/lib/auth");
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(betterAuthUserId);
  if (!user) return false;

  return isBanActive(user as BannableUserRow);
}
