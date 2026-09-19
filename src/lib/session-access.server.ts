import "server-only";
import { getUserAccessContext, type UserAccessContext } from "@/lib/auth-status";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * The ONE sanctioned way to resolve an application access context for a
 * COOKIE SESSION (IMP-1).
 *
 * `getUserAccessContext` takes a Better Auth user id and cannot see the
 * session, so it cannot know whether that id is the person at the browser or
 * an identity an administrator has BORROWED via impersonation. Every cookie
 * caller — the secure layout, the admin RSC gate, the navigation menus, the
 * docs asset route, the unified caller resolver — therefore funnels through
 * here, which reads Better Auth's `impersonatedBy` marker off the session and
 * hands it down so the resolved organization is confined to the
 * IMPERSONATOR's own tenancy.
 *
 * Why a module of its own rather than a second export of `auth-status.ts`:
 * the marker reader lives in the dependency-free `@/lib/impersonation` so
 * both session guards can share it (review #28), and keeping this helper out
 * of `auth-guard.ts` keeps it importable from the caller resolver without
 * dragging the Better Auth instance into that import graph.
 *
 * The rule that nothing else resolves a session's context is enforced
 * statically by tests/unit/session-access-context-invariant.test.ts: a new
 * caller that reaches for `getUserAccessContext` directly fails CI rather
 * than silently shipping an unconfined impersonation. The optional
 * `impersonatedBy` argument is fail-open ON ITS OWN — that scan is what makes
 * the system fail closed, so do not remove it when adding a call site.
 */
export interface SessionLike {
  user: { id: string };
  /**
   * Better Auth's session row. Declared as `unknown` because the only thing
   * read from it is the `impersonatedBy` marker, and the admin plugin has
   * shipped it in two casings — {@link readImpersonatorId} owns that quirk.
   */
  session?: unknown;
}

export function getSessionAccessContext(session: SessionLike): Promise<UserAccessContext> {
  const impersonatorId = readImpersonatorId(session);
  return getUserAccessContext(
    session.user.id,
    undefined,
    impersonatorId ? { betterAuthUserId: impersonatorId } : undefined,
  );
}
