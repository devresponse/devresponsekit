# Form Validation — System-Wide Improvement Plan

> Status: **plan / not yet implemented**. This document is the agreed design for
> bringing every form in the app onto a single, accessible, type-safe validation
> pattern. Scope: **all 21 forms** (admin, account, and auth).

## Goals

1. **Required fields are visually marked** — an asterisk (`*`) next to the label
   on every required control, on every form.
2. **Errors highlight the offending control** — a red border on the input/select/
   textarea that needs attention, plus a field-level message beneath it (not a
   single generic "The submitted data is invalid." banner).
3. **Robust, decoupled validation** — React Hook Form + Zod with a schema that is
   the single source of truth, shared between client and server.
4. **Type safety** — form value types derive from the Zod schema (`z.infer`).
5. **Accessibility first** — `aria-required`, `aria-invalid`, `aria-describedby`,
   focus-the-first-error, `role="alert"` messages, and no color-only signalling.

---

## Current state (what we're starting from)

The building blocks are already installed — the work is wiring them up
consistently, not adding dependencies.

| Area | Reality today |
| --- | --- |
| shadcn RHF wrapper | **Exists** (`src/components/ui/form.tsx`): `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `useFormField`. `FormControl` already sets `aria-invalid` + `aria-describedby`; `FormMessage` already renders `role="alert"`. **No form uses it.** |
| Dependencies | `react-hook-form@7.74`, `@hookform/resolvers@5.2.2`, `zod@4.3.6` — all installed; `zodResolver` used **nowhere**. |
| Base controls | `input.tsx` / `textarea.tsx` / `select.tsx` have **no `aria-invalid` styling**. `input-group.tsx` already uses `has-[[aria-invalid=true]]` — precedent for the CSS approach. |
| Forms (21) | All use `useState` + hand-rolled validation + a **single generic error banner**. No asterisks. Several raw `<select>` elements. |
| Validation rules | Server Zod schemas are authoritative; each client form **re-implements** the regexes/lengths → drift risk. |
| i18n | next-intl, `*.errors.*` namespaces; **no** dedicated `validation.*` namespace. Locale parity enforced across `en/fr/es/uk/pt/zh/hi/ja`. |
| Tests | Auth form component tests (happy path + banner) and API-schema security tests. **No** field-level / `aria-invalid` / asterisk assertions. |

---

## Design decisions

| Concern | Decision | Why |
| --- | --- | --- |
| Schema location | One Zod schema per form under `src/lib/validation/<domain>.ts`, **imported by both the API route and the client form**. | Kills client/server drift; `z.infer` types the form. |
| Required asterisk | **Derived from the schema** — `FormLabel` shows `*` when the field's Zod node is not `.optional()`. Explicit `required` prop as an escape hatch. | Single source of truth; no manual flag to forget. |
| Error border | Style **base controls** once on `aria-invalid`; `FormControl` already sets `aria-invalid`, so migrated fields get the border for free. | Zero per-field styling code; consistent. |
| Validation timing | `mode: "onTouched"`, `reValidateMode: "onChange"`, `shouldFocusError: true`. | Don't shout while first typing; correct live after blur; focus first error on submit. |
| Field errors | `FormMessage` per field; the banner survives only for non-field failures (network, 403). | Precise, actionable feedback. |
| Server → field mapping | Routes return `parsed.error.flatten()`; client maps `fieldErrors` via `setError(field, …)`, unmapped → `setError("root.server", …)`. | A 409 "email taken" lands **on the email field**. |
| Localized messages | Schemas stay message-agnostic (issue codes); a Zod error map translates codes → `validation.*` next-intl keys at the edge. | Keeps schemas reusable on client + server; one place to translate. |

---

## Phase 0 — Foundation (1 PR; the reference implementation)

Build the shared pieces and migrate the **new-user** form (the screen that
prompted this) to prove the full stack.

### 0.1 Base-control error styling
Add to `input.tsx`, `textarea.tsx`, and the `SelectTrigger` in `select.tsx`:
```ts
"aria-invalid:border-destructive aria-invalid:ring-destructive/30 aria-invalid:focus-visible:ring-destructive/40"
```
Replace raw `<select>` in forms with the shadcn `Select` (or a small styled
native wrapper) so it can carry `aria-invalid`.

### 0.2 Schema-aware `FormLabel` + required indicator
In `form.tsx`, `useFormField` gains `isRequired` (derived from the active schema
via a `FormSchemaContext` set by `<Form schema={…}>`); the control receives
`aria-required`:
```tsx
function FormLabel({ required, children, ...props }) {
  const { error, formItemId, isRequired } = useFormField();
  const show = required ?? isRequired;
  return (
    <Label htmlFor={formItemId} className={cn(error && "text-destructive")} {...props}>
      {children}
      {show && <span aria-hidden className="text-destructive ml-0.5">*</span>}
    </Label>
  );
}
```
Add a localized `<RequiredLegend/>` ("`*` indicates a required field").

### 0.3 `useZodForm` helper (`src/lib/forms/use-zod-form.ts`)
```ts
export function useZodForm<S extends ZodType>(schema: S, opts?) {
  return useForm<z.infer<S>>({
    resolver: zodResolver(schema),
    mode: "onTouched",
    reValidateMode: "onChange",
    shouldFocusError: true,
    ...opts,
  });
}
```
Plus `applyServerErrors(form, flattened)` mapping `fieldErrors` → `setError`, with
a `root.server` fallback for the banner.

### 0.4 i18n
New `validation.*` namespace (`required`, `email`, `min`, `max`, `pattern`,
`passwordMin`, `passwordsMismatch`, `slug`, `key`, …) in **en/fr/es/uk/pt/zh/hi/ja**,
surfaced through a Zod error map so schemas stay message-agnostic. The
locale-parity test guards all four.

### 0.5 First shared schema
Extract `createUserSchema` to `src/lib/validation/users.ts`; import it in **both**
`/api/administrator/users/route.ts` and `_new-user-form.tsx`.

### 0.6 Migrate `_new-user-form.tsx`
Convert to `Form` / `FormField` / `FormControl` / `FormMessage` + `useZodForm`.
Result on the create-user screen: asterisks on Email/Password, red borders +
per-field messages on invalid submit, 409 mapped onto the email field, generic
banner gone.

### 0.7 Tests (the template)
Component test asserting: asterisk on required fields, invalid submit →
`aria-invalid` + `FormMessage`, server-error mapping, happy path. Later forms
copy this.

---

## Phases 1–N — Migrate all remaining forms (batched PRs)

Same recipe each form: **extract shared schema → `useZodForm` → `Form*`
primitives → server-error mapping → tests**. One PR per small batch
(one-PR-per-logical-change; they auto-merge independently).

### Migration checklist (21 forms)

**Admin — create (Phase 1)**
- [ ] `administrator/users/new/_new-user-form.tsx` *(done in Phase 0)*
- [ ] `administrator/roles/new/_new-role-form.tsx`
- [ ] `administrator/organizations/new/_new-organization-form.tsx`
- [ ] `administrator/groups/new/_new-group-form.tsx`
- [ ] `administrator/permissions/new/_new-permission-form.tsx`
- [ ] `administrator/enterprise-apps/new/_new-enterprise-app-form.tsx`
- [ ] `administrator/api-keys/new/_new-api-key-form.tsx`

**Admin — edit/settings (Phase 2)**
- [ ] `administrator/roles/[roleId]/_role-settings-form.tsx`
- [ ] `administrator/organizations/[orgId]/_organization-settings-form.tsx`
- [ ] `administrator/groups/[groupId]/_group-settings-form.tsx`
- [ ] `administrator/enterprise-apps/[appId]/_enterprise-app-settings-form.tsx`
- [ ] `administrator/email/templates/[templateId]/_template-edit-form.tsx`

**Account (Phase 3)**
- [ ] `account/profile/_profile-form.tsx`
- [ ] `account/preferences/_preferences-form.tsx`
- [ ] `account/security/_password-form.tsx`

**Auth (Phase 4)** — these call the Better Auth client; they still gain RHF+Zod,
asterisks, and field errors, with auth failures mapped to the root banner.
- [ ] `components/auth/email-password-login-form.tsx`
- [ ] `components/auth/email-password-sign-up-form.tsx`
- [ ] `components/auth/forgot-password-form.tsx`
- [ ] `components/auth/reset-password-form.tsx`
- [ ] `components/auth/sign-in-form.tsx` *(composition wrapper — no change beyond passing through)*
- [ ] `components/auth/sign-up-form.tsx` *(composition wrapper — no change beyond passing through)*

---

## Cross-cutting work

- **Routes return structured field errors** (`parsed.error.flatten()`) so the
  client can map them precisely — done per route as its form migrates.
- **Guardrail test**: scan `*-form.tsx` files to ensure new forms route through
  `FormControl` (prevents regressing to raw inputs).
- **Locale parity** stays green — validation keys added to all eight locales in
  each PR that introduces them.

## Accessibility checklist (every migrated form)

- [ ] Required controls have `aria-required` and a visible `*` (`aria-hidden`) on the label.
- [ ] Invalid controls set `aria-invalid` (red border) and link their message via `aria-describedby`.
- [ ] Field messages use `role="alert"` (already in `FormMessage`).
- [ ] Submitting an invalid form moves focus to the first invalid field.
- [ ] A localized "`*` indicates a required field" legend is present.
- [ ] Errors are never color-only (asterisk + text message accompany the border).

## Testing strategy

- **Component (RTL)** per form: asterisk presence, invalid-submit → `aria-invalid`
  + `FormMessage` text, server-error mapping, happy-path submit.
- **Security** tests (existing) continue to assert the shared Zod schemas reject
  unknown keys / oversized / malformed input at the API.
- **Accessibility**: the existing Playwright + axe suite covers the migrated pages.

## Rollout & effort

- Phase 0: ~1 focused PR (infra + new-user form + tests).
- Forms: ~6–8 PRs grouped as above (2–4 forms each).
- Each PR independently passes the full gate (typecheck, lint, format, build,
  `test:coverage`) and CI (quality + Playwright a11y).

## Risks

- **Native `<select>`** needs `aria-invalid` support (handled in 0.1).
- **Zod 4 + resolvers v5** — compatible; confirm the `zodResolver` import path in Phase 0.
- **`FormControl` uses Radix `Slot`** — verify it forwards `aria-*` onto our
  `Input`/`Select` (it should; quick check in 0.1).
- **Auth forms** — async Better Auth failures must map to the root banner, not a
  phantom field.

## Acceptance criteria

- Every required field across all 21 forms shows an asterisk.
- Invalid submits show a red border + a field-level message on each offending
  control; the generic "submitted data is invalid" banner is gone for
  field-mappable errors.
- Client and server validate against the **same** Zod schema per form.
- Forms are keyboard- and screen-reader-accessible per the checklist above.
- The full test gate and CI are green.
