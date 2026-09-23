/**
 * Credential issuance — the ONE authority check every path that hands out a
 * credential secret, or changes what an existing credential can do, runs
 * before it writes (F-01).
 *
 * "Issuance" is broader than minting. Each of these puts a bearer credential
 * with a given scope set into somebody's hands, and each is therefore bounded
 * by the same rule:
 *
 *   - minting an API key or registering an OAuth client (self or on behalf);
 *   - ROTATING one: the successor carries the ORIGINAL scopes forward
 *     verbatim, and the new plaintext goes to whoever asked — so a rotation
 *     is an issuance of the existing scope set to the actor;
 *   - re-scoping an OAuth client in place (the actor may already hold its
 *     secret, so widening it is issuing the wider set to them).
 *
 * The rule has three parts:
 *
 *   1. The ACTOR may only confer scopes it could grant itself
 *      ({@link ungrantableScopesForCaller}: a cookie session's permissions, a
 *      bearer credential's own scopes). Before this module, rotation never
 *      ran it at all, so an org admin holding only `admin.apikeys.manage`
 *      could rotate a co-member's `admin.users.*` key and receive it.
 *   1a. On behalf of ANOTHER principal, the actor's scope must also be one
 *      its owner's LIVE permissions cover — scope ∩ permission, F-05. A
 *      bearer grant can name more than its owner holds (an agent ceiling set
 *      above its service user's role, or any key whose owner was later
 *      downgraded; scopes are never re-intersected on a role change). The
 *      excess is inert at USE, where the guards intersect with live
 *      permissions — but conferred on a credential for a co-member who DOES
 *      hold it, it becomes live. For the actor's OWN credential (a key
 *      rotating itself) the excess stays inert, so it is not refused there.
 *   2. The account-WRITING scopes (`account.apikeys.manage`,
 *      `account.profile.write`, `account.preferences.write`) are never
 *      conferred on a credential that authenticates as SOMEONE ELSE — nor by
 *      an impersonated session, which only looks like the owner. They are
 *      "self-grantable" because they act on the owner's own account, which is
 *      exactly why an administrator must not hold them for another principal:
 *      an on-behalf key carrying `account.apikeys.manage` reached the owner's
 *      self-service key surface, which is where the cross-tenant takeover in
 *      F-01 started. `account.read` stays grantable on behalf: it is read-only
 *      introspection of the principal inside the credential's own tenant, and
 *      it is what an agent's `whoami` tool and a service principal's `/me`
 *      probe need.
 *
 * The module is pure (no IO) so the rule is unit-testable on its own; the
 * routes render the refusal in their own envelope.
 * `tests/unit/credential-issuance-invariant.test.ts` fails the build when a
 * route handler issues a credential without calling it.
 */
import {
  ACCOUNT_SCOPES,
  scopeMatches,
  ungrantableScopes,
  ungrantableScopesForCaller,
} from "@/lib/api-auth/scopes";

/** The account scopes that change the principal's own account or credentials. */
export const ACCOUNT_WRITE_SCOPES: ReadonlyArray<string> = ACCOUNT_SCOPES.filter(
  (scope) => scope !== "account.read",
);

/** Who is issuing, with the authority their CALLING credential carries. */
export interface CredentialIssuer {
  /** `null` when the caller is not provisioned — treated as "not the owner". */
  appUserId: string | null;
  permissions: ReadonlyArray<string>;
  /** `null` for a cookie session (full user authority). */
  grantedScopes: ReadonlyArray<string> | null;
  /**
   * The impersonating admin's id when the caller is an impersonated session,
   * else `null`. Such a session carries the BORROWED user's `appUserId`, so
   * without this it would count as the owner of that user's credentials.
   */
  impersonatorId: string | null;
}

export interface CredentialIssuance {
  issuer: CredentialIssuer;
  /** The principal the credential will authenticate AS (`app_users.id`). */
  ownerAppUserId: string;
  /** The scope set the resulting credential will carry. */
  scopes: ReadonlyArray<string>;
}

/**
 * True when `scope` would authorize any account-WRITING scope — the exact
 * scopes and any wildcard that expands over them (`account.*`,
 * `account.apikeys.*`, `*`).
 */
export function reachesAccountWriteScope(scope: string): boolean {
  return ACCOUNT_WRITE_SCOPES.some((writeScope) => scopeMatches(scope, writeScope));
}

/**
 * True unless the issuer is, genuinely, the credential's owner: an
 * unprovisioned issuer is never the owner, and neither is an impersonated
 * session (fail closed).
 */
export function isOnBehalfOfAnother(
  issuance: Pick<CredentialIssuance, "issuer" | "ownerAppUserId">,
) {
  const { issuer, ownerAppUserId } = issuance;
  if (issuer.impersonatorId) return true;
  return issuer.appUserId === null || issuer.appUserId !== ownerAppUserId;
}

/**
 * The requested scopes the issuer may NOT put on this credential, in request
 * order; empty when the issuance is allowed. See the module doc for the rule.
 */
export function unissuableScopes(issuance: CredentialIssuance): string[] {
  const { issuer, scopes } = issuance;
  const refused = new Set(
    ungrantableScopesForCaller(issuer.permissions, issuer.grantedScopes, scopes),
  );
  if (isOnBehalfOfAnother(issuance)) {
    // F-05: scope ∩ permission for anything conferred on someone else. A
    // no-op for a cookie issuer (its branch above already is exactly this).
    for (const scope of ungrantableScopes(issuer.permissions, scopes)) refused.add(scope);
    for (const scope of scopes) {
      if (reachesAccountWriteScope(scope)) refused.add(scope);
    }
  }
  return scopes.filter((scope) => refused.has(scope));
}
