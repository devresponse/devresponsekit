# Sign-up Policy (per-organization authentication workflow)

_Audience: administrators and developers. How new accounts register and become active, how to configure a different workflow per organization at runtime, and the guarantees behind each option._

---

## 1. Overview

The signup workflow is **runtime-configurable per organization** and persisted in the database (`app_organization_auth_settings`, migration `0007`). Administrators choose, per organization, whether email verification is required and how a new account becomes active — no code change, environment variable, or restart involved.

Two decisions are policy-driven:

1. **Email verification** — must an email/password registration confirm its address before it can sign in?
2. **Activation** — does a new account start `active`, or park in `pending_approval` until an administrator approves it?

Everything downstream (the `pending-approval` and `blocked` gates, `decideSecureAccess`) is unchanged: statuses remain the single source of truth.

## 2. The settings

| Setting | Values (default in bold) | Effect |
| --- | --- | --- |
| `requireEmailVerification` | **`true`** / `false` | Off ⇒ email/password sign-ups are pre-verified at creation and signed in immediately. Social sign-ins (Google, Microsoft, GitHub) arrive provider-verified and are unaffected. |
| `signupApprovalMode` | **`admin_approval`** / `auto_active` | `admin_approval`: new members start `pending_approval`. `auto_active`: new members are activated on provisioning. |
| `allowedAuthMethods` | **`null`** (all) or a subset of `email`, `google`, `microsoft`, `github` | A sign-up via an excluded method still provisions but parks in `pending_approval` — visible to admins, never silently dropped. Applies even under `auto_active`. |
| `autoApproveEmailDomains` | **`null`** (none) or a domain list | **Verified** addresses on a listed domain activate immediately, even under `admin_approval`. An unverified address never rides a domain match. |

### Workflow matrix

| Verification | Approval | Resulting workflow |
| --- | --- | --- |
| required | admin approval | Registration → verify email → sign in → pending page → admin approves (the platform default; identical to the pre-0007 behavior) |
| required | auto-active | Registration → verify email → immediately active |
| waived | admin approval | Registration → signed in at once → pending page → admin approves |
| waived | auto-active | Open signup: registration → immediately active (the editor shows a warning for this combination) |
| required | admin approval + auto-approve domain | Colleagues on the listed domain activate the moment they click the verification link; everyone else awaits approval |

## 3. Resolution order and fail-closed guarantees

For any organization the effective policy resolves as:

1. the organization's **own row** — a COMPLETE policy (there is no per-field inheritance);
2. else the single **platform-default row** (`organization_id IS NULL`, seeded by migration `0007` to verification + admin approval);
3. else hardcoded **fail-closed constants** equal to that same strict default.

Every failure mode — missing rows, malformed values, a database error during signup-time resolution — degrades to the *strictest* policy, never a more permissive one. Policy reads happen at signup time (the verification decision) and at provisioning time (the activation decision), so edits apply to the next registration with no restart.

## 4. Which organization governs a sign-up?

The policy consulted is the policy of the organization the account will land in:

- **Microsoft** — the Entra tenant id (`tid`) resolves to its bound organization.
- **Google** — the hosted domain (`hd`) resolves to its bound organization.
- **GitHub** — the verified email's domain.
- **Email/password** — an admin-curated **email-domain binding** (a provider binding with provider `email`, managed on the organization's Providers tab or via `…/provider-bindings`) routes the domain's sign-ups to that organization; otherwise they land in the `default` organization, governed by its policy.

An organization auto-created by a first OAuth sign-in has no policy row yet, so the platform default governs its first member.

## 5. Activation re-evaluation at sign-in

A still-pending account is re-evaluated against the **current** policy when it signs in, and activated when the policy now says active:

- the account's email is now verified and matches an auto-approve domain (this is how a "verify + approve-by-domain" org activates its members the moment they click the verification link), or
- the organization has switched to `auto_active` (a brand-new registration would be active anyway, so keeping the old row pending protects nothing and only clutters the approval queue).

This is the **only** automatic upgrade path, it only ever touches `pending_approval` rows, and a concurrent admin action wins. `blocked`, `suspended`, and `deactivated` are explicit administrator denials and are never changed by policy.

## 6. Administering the policy

- **Per organization** — Administrator → Organizations → *organization* → **Authentication** tab. An organization without an override shows the inherited platform defaults with a **Customize** button; **Reset to platform defaults** removes the override again. Requires `admin.orgs.update` (viewing requires `admin.orgs.read`).
- **Platform defaults** — the **Platform sign-up defaults** card on the Organizations page, visible to superadmins only: editing it changes every organization without its own override.
- **API** — `GET/PATCH/DELETE /api/administrator/organizations/:id/auth-settings` and the superadmin-only `GET/PATCH /api/administrator/auth-settings/defaults`; see [Admin Manager §8.2](./admin-manager.md#82-organizations) and the committed [`openapi-admin.json`](./openapi-admin.json).

Changes are audited with previous→next values: `admin.organization.auth_policy_updated`, `admin.organization.auth_policy_reset`, `admin.platform.auth_policy_updated`. Provisioning decisions are audited too: a policy-activated account emits `auth.account.auto_activated` (with the decision reason), a parked one `auth.account.pending_approval`.

## 7. Security notes

- **Fail closed, always.** Absent or unreadable policy means verification + admin approval.
- **Domain auto-approval requires proof.** Only a VERIFIED address can activate via `autoApproveEmailDomains`, so claiming `ceo@acme.com` at registration grants nothing until the mailbox is proven.
- **`auto_active` without verification is open signup.** Anyone who registers gets access without proving mailbox ownership — the editor warns about this combination; choose it only for deliberately open organizations.
- **Method restriction never hides accounts.** Excluded-method sign-ups are parked pending rather than rejected, so administrators can see and triage them.
- **Programmatic creation is unaffected.** Seeds and the admin/machine-API user creation set verification and status explicitly.

## 8. Data model (reference)

`app_organization_auth_settings` — one row per organization plus one platform-default row (`organization_id IS NULL`, pinned unique by a partial index). `signup_approval_mode` and `allowed_auth_methods` are CHECK-constrained; rows are removed by `ON DELETE CASCADE` with their organization. Resolution and the pure status decision live in `src/lib/auth-policy.server.ts`; enforcement lives in the Better Auth hooks (`src/lib/auth.ts`) and `src/lib/user-provisioning.server.ts`.
