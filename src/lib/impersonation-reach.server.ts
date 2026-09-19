import "server-only";
import { cache } from "react";
import { listActiveOrganizationIdsForBetterAuthUser } from "@/lib/active-org.server";
import { betterAuthUserIsGlobalSuperuser } from "@/lib/admin/access-scope.server";

/**
 * How far an IMPERSONATED session may reach — the single definition of the
 * IMP-1 tenant confinement, shared by the resolver that enforces it
 * (`getUserAccessContext`) and the shell that renders it (the org switcher).
 *
 * THE INVARIANT is "a borrowed session reaches no further than its BORROWER
 * could reach AS THEMSELVES". IMP-1 implemented that as the impersonator's
 * active MEMBERSHIP rows, which is correct for every principal but one.
 *
 * IMP-2 — MEMBERSHIP IS THE PROXY FOR REACH, NOT REACH ITSELF. Everywhere else
 * in this codebase a principal's tenant reach is asked with
 * `hasCrossOrgReach` / `userIsGlobalSuperuser`, and for an UNBOUND GLOBAL
 * SUPERUSER the two answers differ: their reach is conferred by permission,
 * not by membership. `canAccessUser` returns true for ANY user on cross-org
 * reach, and `POST /api/administrator/organizations` never enrols the creator
 * as a member, so "superadmin impersonates a user in a customer tenant they do
 * not belong to" is not an edge case — it is the normal shape of the platform
 * operator's primary support flow, and the membership intersection made it
 * resolve NOTHING: no org, no permissions, not even `shell.view`, so
 * `decideSecureAccess` answered `pending_approval`, every API route answered
 * 403, and `requireSecureSession` redirected to `/[locale]/pending-approval` —
 * a page outside the `(secure)` group, so it renders neither the impersonation
 * banner's Stop control nor a sign-out button. The admin was stranded in a
 * borrowed identity recoverable only by hand-calling
 * `DELETE …/impersonate` or clearing cookies.
 *
 * So a superadmin impersonator is UNCONFINED (`null`), and that cannot reopen
 * IMP-1: the pivot attack requires a NON-superadmin actor, because a
 * superadmin already holds every permission in every organization and has
 * nothing to escalate to — which is exactly why the impersonate route's
 * escalation guards skip them on the same predicate.
 *
 * Everyone else keeps the intersection, and `betterAuthUserIsGlobalSuperuser`
 * fails closed on its own terms: it requires an ACTIVE membership in the org
 * conferring the marker AND an active account, so a membership-less or
 * suspended "superadmin" falls through to the membership list — which for the
 * same reasons comes back empty, and an empty list means "resolve nothing",
 * never "unconfined".
 *
 * Wrapped in React `cache()` so the shell layout and every guard in one render
 * share a single pair of round trips. The argument is a plain string, so the
 * memo actually hits (`cache()` compares arguments with `Object.is`).
 */
export const listImpersonationReachableOrgIds = cache(
  async function listImpersonationReachableOrgIds(
    impersonatorBetterAuthUserId: string,
  ): Promise<string[] | null> {
    if (await betterAuthUserIsGlobalSuperuser(impersonatorBetterAuthUserId)) return null;
    return listActiveOrganizationIdsForBetterAuthUser(impersonatorBetterAuthUserId);
  },
);
