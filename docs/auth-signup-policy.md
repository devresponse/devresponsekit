---
title: Sign-up Policy
description: How new accounts register and activate, configurable per organization at runtime.
group: General
order: 80
---

# Sign-up Policy (per-organization authentication workflow)

_Audience: administrators and developers. How new accounts register and become active, how to configure a different workflow per organization at runtime, and the guarantees behind each option._

---

## 1. Overview

The signup workflow is **runtime-configurable per organization** and persisted in the database (`app_organization_auth_settings`, defined in `0001-initial-schema.sql`). Administrators choose, per organization, whether email verification is required and how a new account becomes active — no code change, environment variable, or restart involved.

Two decisions are policy-driven:

1. **Email verification** — must an email/password registration confirm its address before it can sign in?
2. **Activation** — does a new account start `active`, or park in `pending_approval` until an administrator approves it?

Everything downstream (the `pending-approval` and `blocked` gates, `decideSecureAccess`) is unchanged: statuses remain the single source of truth.

## 2. The settings

| Setting | Values (default in bold) | Effect |
| --- | --- | --- |
| `requireEmailVerification` | **`true`** / `false` | Off ⇒ email/password sign-ups are pre-verified at creation and signed in immediately. Social sign-ins (Google, Microsoft, GitHub) arrive provider-verified and are unaffected. |
| `signupApprovalMode` | **`admin_approval`** / `auto_active` / `invite_only` | `admin_approval`: new members start `pending_approval`. `auto_active`: new members are activated on provisioning. `invite_only`: uninvited sign-ups park in `pending_approval`; [invited](#6-invitations) ones activate. |
| `allowedAuthMethods` | **`null`** (all) or a subset of `email`, `google`, `microsoft`, `github` | A sign-up via an excluded method still provisions but parks in `pending_approval` — visible to admins, never silently dropped. Applies even under `auto_active`; a valid [invitation](#6-invitations) overrides it. |
| `autoApproveEmailDomains` | **`null`** (none) or a domain list | **Verified** addresses on a listed domain activate immediately, even under `admin_approval` or `invite_only`. An unverified address never rides a domain match. Requires `requireEmailVerification = true` — the combination with verification waived is rejected (with it off, no address is proven, so a domain rule would auto-activate anyone claiming the domain). |

### Workflow matrix

| Verification | Approval | Resulting workflow |
| --- | --- | --- |
| required | admin approval | Registration → verify email → sign in → pending page → admin approves (the platform default; identical to the pre-0007 behavior) |
| required | auto-active | Registration → verify email → immediately active |
| waived | admin approval | Registration → signed in at once → pending page → admin approves |
| waived | auto-active | Open signup: registration → immediately active (the editor shows a warning for this combination) |
| required | admin approval + auto-approve domain | Colleagues on the listed domain activate on their first sign-in right after confirming their email; everyone else awaits approval |
| any | invite-only | Invited users activate on acceptance; anyone else who registers parks in `pending_approval` (never rejected outright — admins keep visibility, and the signup endpoint gives no account-existence oracle) |

A **valid invitation activates under every mode and overrides the method allow-list** — the invitation IS the approval, and as a targeted, admin-issued grant for one specific address it is more specific than the org-level gate on unsolicited sign-ups.

## 3. Resolution order and fail-closed guarantees

For any organization the effective policy resolves as:

1. the organization's **own row** — a COMPLETE policy (there is no per-field inheritance);
2. else the single **platform-default row** (`organization_id IS NULL`, seeded by the `app_organization_auth_settings` section of `0001-initial-schema.sql`);
3. else hardcoded **fail-closed constants** equal to that same strict default.

Every failure mode — missing rows, malformed values, a database error during signup-time resolution — degrades to the *strictest* policy, never a more permissive one. Policy reads happen at signup time (the verification decision) and at provisioning time (the activation decision), so edits apply to the next registration with no restart.

## 4. Which organization governs a sign-up?

The policy consulted is the policy of the organization the account will land in:

- **Microsoft** — the Entra tenant id (`tid`) resolves to its bound organization.
- **Google** — the hosted domain (`hd`) resolves to its bound organization.
- **GitHub** — the verified email's domain.
- **Email/password** — an admin-curated **email-domain binding** (a provider binding with provider `email`, managed on the organization's Providers tab or via `…/provider-bindings`) routes the domain's sign-ups to that organization; otherwise they land in the `default` organization, governed by its policy.

An organization auto-created by a first OAuth sign-in has no policy row yet, so the platform default governs its first member.

A visitor who arrives through an **organization-scoped sign-in** (`/sign-in/<org>` or `?org=`) targets that organization directly — ranked above provider/domain inference and below an invitation. See §7.

## 5. Activation re-evaluation at sign-in

A still-pending account is re-evaluated against the **current** policy when it signs in, and activated when the policy now says active:

- the account's email is now verified and matches an auto-approve domain (this is how a "verify + approve-by-domain" org activates its members right after they confirm their email and sign in), or
- the organization has switched to `auto_active` (a brand-new registration would be active anyway, so keeping the old row pending protects nothing and only clutters the approval queue).

This is the **only** automatic upgrade path, it only ever touches `pending_approval` rows, and a concurrent admin action wins. `blocked`, `suspended`, and `deactivated` are explicit administrator denials and are never changed by policy.

**Verification is a distinct step from sign-in.** Clicking the emailed verification link confirms the address but does **not** create a session (`autoSignInAfterVerification` is off) — it lands on a localized "email verified — proceed to sign in" confirmation page, and the user signs in explicitly. Activation (the re-evaluation above) therefore happens on that first post-verification sign-in, not on the link click itself.

**The seed sets the platform sign-up default to `auto_active`** (`require_email_verification = true` + `signup_approval_mode = auto_active`), so a self-registered user who verifies their email is active with **no administrator-approval step**. This is the row shown by the **Platform sign-up defaults** admin panel and is inherited by every organization without its own override (including the `default` org, where self-registrations land). The `0001-initial-schema.sql` migration still seeds this row **fail-closed** (`admin_approval`) as a defensive baseline; `db:seed` relaxes it to `auto_active` for this deployment.

## 6. Invitations

An administrator invites an email address into an organization (optionally with an app role); the invitee receives an email with a **single-use accept link** that expires in **7 days**. Accepting creates or activates the membership in the **inviting** organization — the invitation is the approval, so it bypasses the pending queue under every mode, and the invited org overrides the provider/domain routing of §4.

**Inviting** — Administrator → Organizations → *organization* → **Members** tab → *Invite member* (email + optional role belonging to that org), or `POST /api/administrator/organizations/:id/invitations`. One pending invitation per (organization, email); inviting an address that already belongs to an active member is refused. **Resend** rotates the token and expiry in place (the old link dies immediately; an expired-but-pending invitation is deliberately revived); **Revoke** kills a pending invitation.

**Invited roles are a deferred role assignment (AUTHZ-3).** Attaching a role to an invitation is bound by the same privilege-escalation guard as assigning a role to a user: a non-superadmin may only attach a role whose permissions are a subset of what they can confer themselves (their own held set; for a bearer credential, further intersected with its scopes). A role that carries anything more — the seeded `superuser` role, or any role bundling a permission the inviter lacks — is refused with **403 `forbidden`** at create time (`src/app/api/administrator/organizations/[id]/invitations/route.ts`). Superadmin cookie sessions are exempt. The check is repeated **at acceptance** against the inviter's *current* authority in the inviting org (`inviterMayConferRole` in `src/lib/invitations.server.ts`): if the inviter has since been demoted, suspended, or deleted (`invited_by` is `NULL`), the membership is still created but the role is withheld, and the `auth.account.invitation_accepted` audit event records `roleDenied: <roleId>` (as opposed to `roleMissing`, which means the role itself no longer exists in that org). A global superuser inviter always passes.

**Accepting** — the emailed link lands on `/invite?token=…`:

- **No account** — *Create account* carries the token into sign-up: the email field is locked to the invited address, the account is **pre-verified** (presenting the token proves mailbox access — the same trust chain as a verification link), signed in immediately, and lands active in the inviting org with the invited role.
- **Existing account** — sign in (the page round-trips), then explicitly accept. Acceptance requires the **session's email to equal the invited address**; a mismatched session sees a sign-out prompt and the invited address is never echoed to it.
- A pending-approval account accepting an invitation is activated; `blocked` / `suspended` / `deactivated` accounts are refused — explicit administrator denials always win.

Unknown, expired, revoked, and already-used tokens all get one generic "invalid or expired" answer, so nothing about organizations or invitees leaks to token guessers. Tokens are ~190-bit CSPRNG secrets stored only as SHA-256 hashes — the plaintext exists solely inside the email.

## 7. Organization-scoped sign-in (`/sign-in/<org>`, `?org=<slug>`)

A shared login screen can be pinned to one organization so members and new users land in the right place. Both forms resolve the same identifier — an organization **slug or id** — and are interchangeable:

- **Path** — `/<locale>/sign-in/<org>` (e.g. `/en/sign-in/acme`).
- **Query** — `/<locale>/sign-in?org=<slug>` (and the same on `/sign-up`).

An unknown identifier renders the plain shared screen — no error, and no signal of whether an organization exists — so the segment is always safe to expose. Resolution matches **active** organizations only, and never creates one.

What the scope does:

- **Branding** — the screen reads "Sign in to _Org_".
- **Existing members** — after authentication the active organization is pinned to the scoped org, via a membership-checked applicator (`GET /api/preferences/active-org/apply`). This covers **both** email and social sign-in, since both redirect through the post-auth `callbackURL`. A non-member falls through untouched to their own organization — the cookie is a selector among the caller's own memberships, never a grant.
- **New users** — the scope also **targets** a brand-new account at the scoped org (placement only: the initial status is still decided by that org's signup policy, §3, so it can never self-activate anyone). The identifier reaches provisioning by two channels: **email/password** carries it in the sign-up body as `organizationHint`; **social** — whose OAuth callback has no sign-up body — carries it in a short-lived `org_signup_hint` cookie the proxy sets on the scoped page (and clears on a plain one) and the sign-in provisioning hook reads on the provider callback. A brand-new social sign-up therefore lands in the scoped org (and, being its member, is then pinned there by the applicator above). Provider-identity routing (§4) still applies when there is no scope.

Precedence: a live **invitation** overrides the scope (§6). The scope is carried between screens — a scoped sign-in's _Create account_ link opens `/sign-up?org=<slug>`, and its _Have an account?_ counterpart points back to the scoped sign-in.

## 8. Administering the policy

- **Per organization** — Administrator → Organizations → *organization* → **Authentication** tab. An organization without an override shows the inherited platform defaults with a **Customize** button; **Reset to platform defaults** removes the override again. Requires `admin.orgs.update` (viewing requires `admin.orgs.read`).
- **Platform defaults** — the **Platform sign-up defaults** card on the Organizations page, visible to superadmins only: editing it changes every organization without its own override.
- **API** — `GET/PATCH/DELETE /api/administrator/organizations/:id/auth-settings` and the superadmin-only `GET/PATCH /api/administrator/auth-settings/defaults`; see [Admin Manager §8.2](./admin-manager.md#82-organizations) and the committed [`openapi-admin.json`](./openapi-admin.json).

Changes are audited with previous→next values: `admin.organization.auth_policy_updated`, `admin.organization.auth_policy_reset`, `admin.platform.auth_policy_updated`. Provisioning decisions are audited too: a policy-activated account emits `auth.account.auto_activated` (with the decision reason), a parked one `auth.account.pending_approval`. Invitations add `admin.organization.invitation_created` / `.invitation_revoked` / `.invitation_resent` and `auth.account.invitation_accepted`.

## 9. Security notes

- **Fail closed, always.** Absent or unreadable policy means verification + admin approval; an invitation lookup failure during sign-up degrades to the uninvited path, never blocks the registration and never activates.
- **Domain auto-approval requires proof.** Only a VERIFIED address can activate via `autoApproveEmailDomains`, so claiming `ceo@acme.com` at registration grants nothing until the mailbox is proven. Because a waived-verification org marks sign-ups verified without proof, that combination is rejected at write time and the decision layer additionally refuses domain approval whenever verification is not required — defense in depth against an unproven address riding a domain into an active membership.
- **Invitations are mailbox-bound.** Acceptance demands an exact email match, so a forwarded link cannot move the seat to another mailbox.
- **`auto_active` without verification is open signup.** Anyone who registers gets access without proving mailbox ownership — the editor warns about this combination; choose it only for deliberately open organizations.
- **Method restriction never hides accounts.** Excluded-method sign-ups are parked pending rather than rejected, so administrators can see and triage them. A valid invitation overrides the restriction — inviting an address IS the sanction, and the explicit accept path is method-agnostic anyway, so a first-ranked allow-list would only be an inconsistent speed bump, not a gate.
- **Programmatic creation is unaffected.** Seeds and the admin/machine-API user creation set verification and status explicitly.
- **Scoped sign-in places, never grants.** `/sign-in/<org>` and `?org=` only _target_ an organization; activation still runs that org's policy, the active-org applicator is membership-checked (the cookie is a selector, not a grant), the hint never creates an organization, and an invitation always overrides it.

## 10. Data model (reference)

`app_organization_auth_settings` — one row per organization plus one platform-default row (`organization_id IS NULL`, pinned unique by a partial index). `signup_approval_mode` and `allowed_auth_methods` are CHECK-constrained; rows are removed by `ON DELETE CASCADE` with their organization. Resolution and the pure status decision live in `src/lib/auth-policy.server.ts`; enforcement lives in the Better Auth hooks (`src/lib/auth.ts`) and `src/lib/user-provisioning.server.ts`.

`app_organization_invitations` — one row per invitation (`token_hash` unique; one *pending* row per (organization, email) via a partial unique index; `role_id` degrades to NULL if the role is deleted; rows cascade with their organization). Lifecycle: `pending` → `accepted` | `revoked`, with expiry enforced at read time. The server core lives in `src/lib/invitations.server.ts`.
