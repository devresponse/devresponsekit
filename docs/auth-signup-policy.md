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
| `requireEmailVerification` | **`true`** / `false` | Off ⇒ email/password sign-ups are pre-verified at creation and signed in immediately. The waiver is recorded distinctly (the Better Auth user field `emailVerificationWaived`) — a waived address is never treated as a **proven** one, see [§9](#9-security-notes). Social sign-ins (Google, Microsoft, GitHub) arrive provider-verified and are unaffected. |
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

**Both reads resolve the same organization.** The verification decision (`resolveSignupPolicy`, in the `user.create.before` hook) and the placement + activation decision (`provisionUserFromAuth`, in the `user.create.after` hook) determine "the organization the account will land in" with one shared precedence — see [§4](#4-which-organization-governs-a-sign-up). Because the organization-scoped hint ranks first in both, the organization whose policy waives verification is always the organization that receives the account; a lax default (or domain-routed) organization can never waive verification for an account that a `?org=` hint then places in a strict one.

## 4. Which organization governs a sign-up?

The policy consulted is the policy of the organization the account will land in, resolved in this order (the same order at sign-up time and at provisioning time):

1. a live **invitation** for the address (§6) — the inviting organization;
2. an **organization-scoped sign-in** hint (`/sign-in/<org>` or `?org=`, §7) that names an existing **active** organization; an unknown or inactive hint is ignored and resolution continues;
3. **provider metadata** — **GitHub only**: the **verified** email's domain becomes the organization key (an unverified GitHub email is ignored and resolution continues);
4. **Email/password** — an admin-curated **email-domain binding** (a provider binding with provider `email`, created via `…/provider-bindings` by a **superadmin** — a binding claims the domain for one organization across the whole platform, so an org admin cannot create one (F-04); consumer mailbox domains such as `gmail.com` are refused) routes the domain's sign-ups to that organization;
5. otherwise the `default` organization, governed by its policy.

**Microsoft and Google tenant claims are deliberately not read** (review #38). The Entra tenant id (`tid`) and the Google hosted domain (`hd`) are **not** consulted at step 3, so a Workspace or Entra sign-up that matches no invitation, no `?org=` hint and no email-domain binding lands in `default` — never in an organization derived from a raw tenant id. The resolver branches for those claims existed but were never reachable (no call site ever supplied the claims) and were removed rather than wired up, because switching them on would have silently repointed every existing Workspace/Entra sign-up out of `default` and spawned GUID-slugged organizations from tenant ids. To place those sign-ups deliberately, use the admin-curated paths: an invitation (§6), an organization-scoped hint (§7), or the `app_provider_organizations` domain binding of step 4. See `src/lib/provider-organization-resolver.ts` for the same statement next to the code.

An organization auto-created by a first OAuth sign-in has no policy row yet, so the platform default governs its first member.

**A sign-up routed into an organization that is not `active` is not re-routed (F-09).** Steps 3–5 (provider metadata, an email-domain binding, `default`) do not look at the target organization's status, so a new account whose domain maps to a suspended tenant still lands there. Its membership simply does not count until an operator reactivates the tenant: the account resolves to no organization and sees the pending-approval screen. That is deliberate. Falling through to `default` instead would let a suspended tenant's people sign up into a different tenant. Steps 1 and 2 do skip a non-active organization: its invitations are dead (§6), and the scoped-sign-in hint only ever matches active organizations (§7).

For email/password sign-ups the verification decision is made by the `user.create.before` hook with steps 2–5 (an invitation is handled by the hook itself: presenting a live token for the address is mailbox proof, so it pre-verifies regardless of policy); provisioning then applies the full order for placement and activation.

## 5. Activation re-evaluation at sign-in

A still-pending account is re-evaluated against the **current** policy when it signs in, and activated when the policy now says active:

- the account's email is now **genuinely** verified and matches an auto-approve domain (this is how a "verify + approve-by-domain" org activates its members right after they confirm their email and sign in) — a verification without mailbox proof (`emailVerificationWaived`: a policy waiver, or an identity created by an org admin rather than a superadmin) never qualifies, so tightening an organization's policy after a waived sign-up cannot auto-activate an unproven address, or
- the organization has switched to `auto_active` (a brand-new registration would be active anyway, so keeping the old row pending protects nothing and only clutters the approval queue).

This is the **only** automatic upgrade path, it only ever touches `pending_approval` rows, and a concurrent admin action wins. `blocked`, `suspended`, and `deactivated` are explicit administrator denials and are never changed by policy.

**Verification is a distinct step from sign-in.** Clicking the emailed verification link confirms the address but does **not** create a session (`autoSignInAfterVerification` is off) — it lands on a localized "email verified — proceed to sign in" confirmation page, and the user signs in explicitly. Activation (the re-evaluation above) therefore happens on that first post-verification sign-in, not on the link click itself.

**The seed sets the platform sign-up default to `auto_active`** (`require_email_verification = true` + `signup_approval_mode = auto_active`), so a self-registered user who verifies their email is active with **no administrator-approval step**. This is the row shown by the **Platform sign-up defaults** admin panel and is inherited by every organization without its own override (including the `default` org, where self-registrations land). The `0001-initial-schema.sql` migration still seeds this row **fail-closed** (`admin_approval`) as a defensive baseline; `db:seed` relaxes it to `auto_active` for this deployment — **on the first run only**. The relaxation is gated on `updated_by IS NULL` (the admin API stamps `updated_by` on every edit; migrations and seeds leave it NULL), so re-running `db:seed` / `db:provision` after an administrator tightened the platform default never reverts it: the seed logs `[seed] platform sign-up policy left as configured (admin-managed)` and moves on. Once administered, the row is changed only through **Administrator → Platform sign-up defaults**.

## 6. Invitations

An administrator invites an email address into an organization (optionally with an app role); the invitee receives an email with a **single-use accept link** that expires in **7 days**. Accepting creates or activates the membership in the **inviting** organization — the invitation is the approval, so it bypasses the pending queue under every mode, and the invited org overrides the provider/domain routing of §4.

**Inviting** — Administrator → Organizations → *organization* → **Members** tab → *Invite member* (email + optional role belonging to that org), or `POST /api/administrator/organizations/:id/invitations`. One pending invitation per (organization, email); inviting an address that already belongs to an active member is refused. **Resend** rotates the token and expiry in place (the old link dies immediately; an expired-but-pending invitation is deliberately revived); **Revoke** kills a pending invitation.

**Invited roles are a deferred role assignment (AUTHZ-3).** Attaching a role to an invitation is bound by the same privilege-escalation guard as assigning a role to a user: a non-superadmin may only attach a role whose permissions are a subset of what they can confer themselves (their own held set; for a bearer credential, further intersected with its scopes). A role that carries anything more — the seeded `superuser` role, or any role bundling a permission the inviter lacks — is refused with **403 `forbidden`** at create time (`src/app/api/administrator/organizations/[id]/invitations/route.ts`). Superadmin cookie sessions are exempt. The check is repeated **at acceptance** against the inviter's *current* authority in the inviting org (`inviterMayConferRole` in `src/lib/invitations.server.ts`): if the inviter has since been demoted, suspended, or deleted (`invited_by` is `NULL`), the membership is still created but the role is withheld, and the `auth.account.invitation_accepted` audit event records `roleDenied: <roleId>` (as opposed to `roleMissing`, which means the role itself no longer exists in that org). A global superuser inviter always passes.

**Accepting** — the emailed link lands on `/invite?token=…`:

- **No account** — *Create account* carries the token into sign-up: the email field is locked to the invited address, the account is **pre-verified** (presenting the token proves mailbox access — the same trust chain as a verification link), signed in immediately, and lands active in the inviting org with the invited role.
- **Existing account** — sign in (the page round-trips), then explicitly accept. Acceptance requires the **session's email to equal the invited address**; a mismatched session sees a sign-out prompt and the invited address is never echoed to it.
- A pending-approval account accepting an invitation is activated; `blocked` / `suspended` / `deactivated` accounts are refused — explicit administrator denials always win.
- **Changing language keeps the invitation (F-35).** The email is rendered in the default locale and its link is anchored to it (`/en`). An invitation is addressed to an email address, not to an account, so no language preference is consulted, even when the invitee already has an account. The language switcher changes only the locale segment of the URL and keeps the query string byte-for-byte, so switching language on `/invite?token=…` or on the invited `/sign-up?invite=…` keeps the invitation (and the locked email).
- **The accept lands in the inviting organization (F-33).** On success, `POST /api/invitations/accept` sets the `active_org` cookie to the inviting org. It uses the same attributes as the org switcher and records an `account.active_organization.changed` audit event with `source: "invitation_accepted"`. An existing member of another org is therefore taken to the org they just joined instead of their earlier one. The cookie is set only when the membership there is now **active**: accepting does not lift an existing `blocked` or `suspended` membership, and the cookie never names an org the user cannot enter. It is never set for an impersonated session. A new account that accepts through sign-up needs no cookie: the session prefers an active membership over any other, so a stray `pending_approval` membership elsewhere (in `default`, say) never outranks the invited org ([Administrator console §8.3](./admin-manager.md#83-memberships)).

Unknown, expired, revoked, and already-used tokens all get one generic "invalid or expired" answer, so nothing about organizations or invitees leaks to token guessers. Tokens are ~190-bit CSPRNG secrets stored only as SHA-256 hashes — the plaintext exists solely inside the email.

**Invitations into an organization that is not `active` are dead (F-09).** While the inviting organization is `pending`, `suspended` or `archived`, its invitations get the same generic "invalid or expired" answer, on every path (the `/invite` page, the explicit accept endpoint, and a token riding a sign-up, which then also stops counting as mailbox proof). The acceptance re-checks the organization inside its single-use flip, so a suspension that lands between opening the link and accepting it still wins. Creating or resending an invitation for such an organization is refused with **409 `organization_not_active`**; revoking stays available. The rows are left `pending`, so once the organization is reactivated an unexpired link works again. See [Administrator console §8.2](./admin-manager.md#82-organizations).

## 7. Organization-scoped sign-in (`/sign-in/<org>`, `?org=<slug>`)

A shared login screen can be pinned to one organization so members and new users land in the right place. Both forms resolve the same identifier — an organization **slug or id** — and are interchangeable:

- **Path** — `/<locale>/sign-in/<org>` (e.g. `/en/sign-in/acme`).
- **Query** — `/<locale>/sign-in?org=<slug>` (and the same on `/sign-up`).

An unknown identifier renders the plain shared screen — no error, and no signal of whether an organization exists — so the segment is always safe to expose. Resolution matches **active** organizations only, and never creates one.

What the scope does:

- **Branding** — the screen reads "Sign in to _Org_".
- **Existing members** — after authentication the active organization is pinned to the scoped org, via a membership-checked applicator (`GET /api/preferences/active-org/apply`). This covers **both** email and social sign-in, since both redirect through the post-auth `callbackURL`. A non-member falls through untouched to their own organization — the cookie is a selector among the caller's own memberships, never a grant.
- **New users** — the scope also **targets** a brand-new account at the scoped org (placement only: the initial status is still decided by that org's signup policy, §3, so it can never self-activate anyone). The scoped org's policy also decides whether the email/password sign-up must verify its address — the verification waiver and the placement always follow the same organization (§4). The identifier reaches provisioning by two channels: **email/password** carries it in the sign-up body as `organizationHint`; **social** — whose OAuth callback has no sign-up body — carries it in a short-lived `org_signup_hint` cookie the proxy sets on the scoped page (and clears on a plain one) and the sign-in provisioning hook reads on the provider callback. A brand-new social sign-up therefore lands in the scoped org (and, being its member, is then pinned there by the applicator above). Provider-identity routing (§4) still applies when there is no scope.

Precedence: a live **invitation** overrides the scope (§6). The scope is carried between screens — a scoped sign-in's _Create account_ link opens `/sign-up?org=<slug>`, and its _Have an account?_ counterpart points back to the scoped sign-in.

## 8. Administering the policy

- **Per organization** — Administrator → Organizations → *organization* → **Authentication** tab. An organization without an override shows the inherited platform defaults with a **Customize** button; **Reset to platform defaults** removes the override again. Requires `admin.orgs.update` (viewing requires `admin.orgs.read`).
- **Platform defaults** — the **Platform sign-up defaults** card on the Organizations page, visible to superadmins only: editing it changes every organization without its own override.
- **API** — `GET/PATCH/DELETE /api/administrator/organizations/:id/auth-settings` and the superadmin-only `GET/PATCH /api/administrator/auth-settings/defaults`; see [Admin Manager §8.2](./admin-manager.md#82-organizations) and the committed [`openapi-admin.json`](./openapi-admin.json).

Changes are audited with previous→next values: `admin.organization.auth_policy_updated`, `admin.organization.auth_policy_reset`, `admin.platform.auth_policy_updated`. Provisioning decisions are audited too: a policy-activated account emits `auth.account.auto_activated` (with the decision reason), a parked one `auth.account.pending_approval`. Invitations add `admin.organization.invitation_created` / `.invitation_revoked` / `.invitation_resent` and `auth.account.invitation_accepted`.

## 9. Security notes

- **Fail closed, always.** Absent or unreadable policy means verification + admin approval; an invitation lookup failure during sign-up degrades to the uninvited path, never blocks the registration and never activates.
- **No provider link into an unproven account (F-03).** Better Auth links a social sign-in into an existing account whose email is verified, and a waived sign-up — or a user an org admin created with a password — is marked verified without anyone proving the mailbox. Linking would hand the real owner an account whose password someone else set. The `user.validateUserInfo` gate (`validateUserInfoForLinking`, `src/lib/auth-verification-waiver.ts`) therefore refuses implicit and explicit provider linking into any account carrying `emailVerificationWaived`, with Better Auth's own `account_not_linked` code. The owner proves the mailbox with a password reset, which clears the marker; the provider sign-in then links. Accounts a cross-org (superadmin) operator created are vouched for and link normally. The marker is written at creation, so accounts an org admin created **before** this rule existed carry none; an operator can mark them (their `admin.user.created` audit rows name the creator). Any other application that writes the shared `user` table — an Option C satellite on the same database — must stamp the marker on its own waived sign-ups and install the same gate, or it reopens this path.
- **Domain auto-approval requires proof.** Only a GENUINELY verified address can activate via `autoApproveEmailDomains`, so claiming `ceo@acme.com` at registration grants nothing until the mailbox is proven. A waived-verification org marks sign-ups verified without proof, so that stamp also carries a distinct, server-only marker (`emailVerificationWaived`, a Better Auth user field a client cannot set) and the decision layer refuses domain approval for any waived flag — whatever organization it later meets, whether through a scoped-sign-in hint or a policy tightened after the sign-up. Two further layers stand behind it: the waived + auto-approve combination is rejected at write time, and domain approval additionally requires the deciding organization to require verification (the backstop for rows created before the marker existed).
- **The waiver follows the target organization.** The sign-up hook resolves the organization the account will land in with the same precedence provisioning uses (§4) — scoped-sign-in hint first — so a lax default or domain-routed organization can never waive verification for an account that then lands in a strict one.
- **A sign-up cannot put the caller's text in someone else's inbox (F-21).** Sign-up takes any address and any name, and the verification email used to greet its recipient by that name, so anyone could make the platform send a signed email carrying their own text (a phishing lure) to a stranger, and repeat it with the resend request. The verification email now greets by the **address**. The password-reset email uses the name only once the owner has proven the address (`emailVerified` and not `emailVerificationWaived`, `resetEmailGreetingName` in `src/lib/auth-user-name.ts`). Names themselves follow one rule everywhere (`src/lib/user-name.ts`): at most 200 characters, no control, line-break or invisible formatting characters. `/sign-up/email` refuses a breaking name with 400 `INVALID_NAME` before it looks the address up, so the refusal is the same for a new and an existing account. The `user.create.before` and `user.update.before` hooks clean and truncate every other write, including an OAuth provider's profile name (refusing that would break the sign-in). Rows written before this rule are not rewritten. An Option C satellite that writes the shared `user` table must apply the same rule itself.
- **Response time does not reveal accounts (F-20).** Sign-up, the forgot-password request and the resend-verification request answer the same way for every address, and they now take the same time too. For sign-up, "the same way" includes the body. With verification required, Better Auth answers an address that already has an account with a synthetic user instead of an error. By default that user had `role: null`, where a real sign-up has `role: "user"` from the admin plugin's create hook, so one request showed whether the account existed, in every organization. `emailAndPassword.customSyntheticUser` in `src/lib/auth.ts` now builds it with the fields a new row gets. Their emails (verification, password reset) are sent after the response, through Next's `after()` (`src/lib/email/defer-send.server.ts`), and a failed send is logged rather than returned. Before, the send was awaited, and a real account answered 200-800 ms slower than an unknown address. What still differs by address is database work: a new sign-up creates and provisions the account, and a reset stores its token. So these three endpoints hold every HTTP response to at least 500 ms plus up to 50 ms of jitter (`src/lib/auth-response-floor.ts`, with the measurements behind the size). The floor does not apply to server-side `auth.api.*` calls, such as the administrator's "send reset email", to a rate-limited 429, or to a sign-up name refused with 400 `INVALID_NAME` (F-21, above): Better Auth skips the after hooks, where the floor waits, once a before hook refuses. That refusal depends only on the name, never on the address, so answering it at once reveals nothing. One difference remains in the body: in an organization that waives verification, a new sign-up comes back already verified (`emailVerified` and `emailVerificationWaived` true) and the form signs it in, while an address that already has an account comes back unverified and is sent to the verify-email page. The same applies to a sign-up carrying a live invitation, but only the invitee holds that token. This is not mirrored in the synthetic user. The form's next step signs in with the password just typed, which fails for an existing account whatever the body says, and the waiver would have to be looked up in the database, which Better Auth's synthetic-user callback cannot do. An organization that waives verification has chosen instant access over hiding which addresses are registered.
- **Invitations are mailbox-bound.** Acceptance demands an exact email match, so a forwarded link cannot move the seat to another mailbox.
- **`auto_active` without verification is open signup.** Anyone who registers gets access without proving mailbox ownership — the editor warns about this combination; choose it only for deliberately open organizations.
- **Method restriction never hides accounts.** Excluded-method sign-ups are parked pending rather than rejected, so administrators can see and triage them. A valid invitation overrides the restriction — inviting an address IS the sanction, and the explicit accept path is method-agnostic anyway, so a first-ranked allow-list would only be an inconsistent speed bump, not a gate.
- **Programmatic creation is unaffected.** Seeds and the admin/machine-API user creation set verification and status explicitly.
- **Scoped sign-in places, never grants.** `/sign-in/<org>` and `?org=` only _target_ an organization; activation still runs that org's policy, the active-org applicator is membership-checked (the cookie is a selector, not a grant), the hint never creates an organization, and an invitation always overrides it.

## 10. Data model (reference)

`app_organization_auth_settings` — one row per organization plus one platform-default row (`organization_id IS NULL`, pinned unique by a partial index). `signup_approval_mode` and `allowed_auth_methods` are CHECK-constrained; rows are removed by `ON DELETE CASCADE` with their organization. Resolution and the pure status decision live in `src/lib/auth-policy.server.ts`; enforcement lives in the Better Auth hooks (`src/lib/auth.ts`) and `src/lib/user-provisioning.server.ts`.

`user.emailVerificationWaived` — a Better Auth **additional user field** (declared in `src/lib/auth.ts`, defined in `src/lib/auth-verification-waiver.ts`) on the vendor `user` table: `true` when `emailVerified` was stamped by a waived-verification policy rather than a mailbox proof. Server-only (`input: false`), default `false`. Written by the `user.create.before` hook for a policy waiver, and by admin/machine-API user creation (`createBetterAuthUser`) unless the creator has cross-org reach — an org admin's say-so is not mailbox proof either (F-03). Cleared by a completed password reset, which proves the mailbox and replaces any previously set password. The column is part of the committed `better-auth-schema.sql` snapshot and is added to an existing database by `pnpm db:auth:migrate` (rows created before it existed read `NULL`, i.e. not waived).

`app_organization_invitations` — one row per invitation (`token_hash` unique; one *pending* row per (organization, email) via a partial unique index; `role_id` degrades to NULL if the role is deleted; rows cascade with their organization). Lifecycle: `pending` → `accepted` | `revoked`, with expiry enforced at read time. The server core lives in `src/lib/invitations.server.ts`.
