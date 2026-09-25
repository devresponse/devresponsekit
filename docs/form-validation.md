---
title: Form Validation
description: The shared Zod and React Hook Form pattern behind every admin, account, and auth form.
group: General
order: 90
---

# Form Validation

> Status: **implemented** (shipped in `1.0.0`). Every form in the app — admin,
> account, and auth — runs on a single, accessible, type-safe validation
> pattern: a shared Zod schema feeds a React Hook Form hook, the schema-aware
> form primitives mark required fields and highlight errors, and all messages
> are localized. This document is the reference for that architecture.

## What you get

1. **Required fields are visually marked** — an asterisk (`*`) next to the label
   on every required control, derived from the schema (no manual flag to forget).
2. **Errors highlight the offending control** — a red border on the
   input/select/textarea plus a field-level message beneath it, instead of a
   single generic banner.
3. **Robust, decoupled validation** — React Hook Form + Zod, with one schema as
   the single source of truth, shared between client and server.
4. **Type safety** — form value types derive from the Zod schema (`z.input` /
   `z.infer`).
5. **Accessibility first** — `aria-required`, `aria-invalid`, `aria-describedby`,
   focus-the-first-error on submit, `role="alert"` messages, and no
   color-only signalling (asterisk + text accompany every border).

---

## Architecture at a glance

```
src/lib/validation/<domain>.ts   shared Zod schema (validation.* message keys)
        │  imported by BOTH ↓
        ├──────────────► API route handler   (server: pass/fail enforcement)
        └──────────────► client form
                              │  via
                         useZodForm(schema)   src/lib/forms/use-zod-form.ts
                              │  rendered with
                         <Form schema={…}>    src/components/ui/form.tsx
                         FormField / FormItem / FormLabel /
                         FormControl / FormMessage
                              │  messages localized at render through
                         the `validation.*` next-intl namespace
```

The flow is **shared schema → `useZodForm` → `Form*` primitives → localized
messages**, with server-only failures (e.g. a uniqueness conflict) mapped back
onto the offending field.

---

## The pieces

### Shared schemas — `src/lib/validation/`

One module per domain, each exporting the Zod schema **and** its inferred type,
imported by both the API route and the client form so the two can never drift:

| Module | Used by |
| --- | --- |
| `users.ts` | admin create-user form + `POST /api/administrator/users` |
| `roles.ts` | admin role create/settings forms + role routes |
| `groups.ts` | admin group create/settings forms + group routes |
| `organizations.ts` | admin organization create/settings forms + org routes |
| `permissions.ts` | admin new-permission form + permission route |
| `enterprise-apps.ts` | admin enterprise-app create/settings forms + app routes |
| `email-templates.ts` | admin template-edit form + template route |
| `api-keys.ts` | admin new-API-key form + API-key route |
| `account.ts` | account profile / preferences / security (password) forms |
| `auth.ts` | sign-in, sign-up, forgot-password, reset-password forms |
| `auth-policy.ts` | org **Authentication** tab + platform-defaults form + the auth-settings routes (0007) |
| `invitations.ts` | invite-member dialog + invitations `POST` and `/api/invitations/accept` (0008) |

Schemas are **message-agnostic**: each Zod issue carries a stable
`validation.*` key (e.g. `z.email("email")`,
`.min(8, "passwordMin")`, `.max(128, "passwordMax")`) rather than prose. The
server only checks pass/fail, so those keys never reach an end user
untranslated; the client localizes them at render time (see `FormMessage`
below). Auth schemas are form-only — those forms call the Better Auth client
directly rather than an app route. The sign-up name is the exception: Better
Auth applies the same rule on the server (next section).

#### A person's name

Every field that sets a person's name uses one of two shared fields from
`src/lib/user-name.ts` instead of its own `z.string()` chain: `userNameSchema` (required) or
`optionalUserNameSchema` (blank means "no name"). They are used by sign-up, the
account profile (name and display name), the admin create-user form and
`POST /api/administrator/users`, `PATCH /api/administrator/users/[id]`,
`POST /api/v1/users` and the MCP client registration (`client_name`). The rule
(F-21):

- at most `USER_NAME_MAX_LENGTH` (200) characters after trimming, with every
  run of whitespace collapsed to one space (`validation.max`). A single
  ideographic space (U+3000, what a Japanese or Chinese input method types for
  the space key) is kept as typed; a non-breaking space, the other width
  variants and a run of two or more become one ordinary space;
- no line breaks, tabs or other control characters, and no invisible
  formatting or text-direction characters such as U+202E
  (`validation.nameCharacters`);
- stored in Unicode NFC. The fields parse to that stored spelling, so a route
  writes exactly what it validated.

The server enforces the same rule where the forms cannot reach. Better Auth's
`/sign-up/email` and `/update-user` refuse a breaking name with 400
`INVALID_NAME` (`src/lib/auth-user-name.ts`), and its `user.create.before` /
`user.update.before` database hooks bound every other write (an OAuth
provider's profile name is cleaned and truncated, never refused, so sign-in
cannot break on it).

### The hook — `src/lib/forms/use-zod-form.ts`

`useZodForm<TValues>(schema, options?)` wraps `useForm` with the
`@hookform/resolvers/zod` resolver and the project's UX defaults:

- `mode: "onTouched"` — validate a field once it has been blurred, not while the
  user is first typing.
- `reValidateMode: "onChange"` — once a field has shown an error, correct it live
  as the user fixes it.
- `shouldFocusError: true` — move focus to the first invalid field on a failed
  submit (keyboard / screen-reader accessibility).

Any option can be overridden via `options`.

The same module exports `applyServerErrors(form, fieldErrors, fallbackMessage?)`,
which maps a server response's per-field errors back onto the form via
`setError`, falling back to the form `root` (rendered as a banner) when no field
error applies. So a 409 "email already taken" lands **on the email field**, and
only genuinely form-level failures (network, 403) use the banner.

### Settings forms seeded from server props (F-39)

An edit form whose starting values come from the server page (RSC props)
builds its form with `useSavedFormBaseline(schema, serverValues, toBody)`
(`src/lib/forms/use-saved-form-baseline.ts`), a wrapper around `useZodForm`.
The organization, role and group **Settings** tabs and the organization
**Authentication** tab use it. Those forms sit in Radix tab panels, which
unmount when another tab opens, so each tab switch remounts the form from the
props the page was rendered with. Before this hook a save did not change those
props, and every save re-sent every field. An admin who suspended an org,
opened Members and came back saw Active again, and the next save of an
unrelated fix quietly reactivated the org. The hook applies three rules:

- **`commitSaved(values)` after a successful save** moves the form's baseline
  to what was saved and calls `router.refresh()`, so the page re-renders and
  its props, and the page header, show the saved state. It moves the baseline
  only: the inputs stay live while the request is in flight, so a field typed
  into meanwhile keeps its text, stays changed, and goes in the next save.
  Every other field is clean at once.
- **The form follows `serverValues`.** When they change, because the refresh
  landed (possibly after a remount that happened while it was in flight), the
  baseline moves to them, and every field the admin has not edited since the
  last save takes the new value. An edit in progress is kept, and so are the
  form's errors and submit state, so a failed save's message is not wiped by
  an earlier save's refresh.
- **`changedBody(values)` builds the PATCH body** from only the fields whose
  value, normalized by `toBody`, differs from that baseline. It returns `null`
  when nothing changed; the form then sends nothing and shows its saved
  message (the role and group routes answer an empty PATCH with 400
  `no_changes`). An untouched field is never written back, even from a stale
  view, and the audit row names only the fields the admin changed (the group
  row's `fields` also carries its `updated_at` stamp). Use it only against a
  partial PATCH contract. The sign-up policy
  route replaces a complete policy, so the Authentication tab sends the whole
  policy and relies on the first two rules.

The role **Permissions** editor is not a React Hook Form form, but it follows
the same rules: it calls `router.refresh()` after every save and takes a new
`initialAssigned` when it has no unsaved moves. `serverValues` must be plain
JSON, because it is compared by its JSON text.

### The primitives — `src/components/ui/form.tsx`

The shadcn React Hook Form wrapper (`Form`, `FormField`, `FormItem`,
`FormLabel`, `FormControl`, `FormMessage`, `useFormField`), extended so the
schema does the work:

- **`<Form schema={…}>`** carries the active Zod schema in context.
- **`FormLabel`** renders the required `*` automatically when the field's
  top-level Zod node rejects `undefined` (i.e. it is not `.optional()`); an
  explicit `required` prop is the escape hatch for `.refine()`-wrapped schemas.
- **`FormControl`** sets `aria-invalid` when the field has an error,
  `aria-required` when the schema marks it required, and wires
  `aria-describedby` to the description and message ids.
- **`FormMessage`** renders the field error with `role="alert"`, and — because
  schema messages are `validation.*` keys — **localizes the key through the
  `validation` next-intl namespace at render**, passing already-localized
  strings (e.g. mapped server errors) through unchanged.

The base controls carry the error styling once: `input.tsx` (and the textarea /
select triggers) include `aria-invalid:border-destructive`, so any field routed
through `FormControl` gets the red border for free.

`RequiredLegend` (`src/components/ui/required-legend.tsx`) renders the localized
"`*` indicates a required field" note; forms place it once near the top.

### Localized messages — the `validation.*` namespace

`src/messages/<locale>.json` carries a dedicated `validation` namespace
(`required`, `email`, `passwordMin`, `passwordMax`, `max`, `nameCharacters`, `passwordsMismatch`,
`slug`, `key`, `uuid`, `subdomain`, `appId`, `ssoAudience`, `number`, `locale`,
`dateFormat`, `requiredLegend`, …) in all eight locales
(`en`/`fr`/`es`/`uk`/`pt`/`zh`/`hi`/`ja`). The locale-parity test keeps every key
present across all locales. Because `FormMessage` and `RequiredLegend` translate
these keys at render, the schemas stay reusable on both client and server.

---

## Worked example — the create-user form

`src/app/[locale]/(secure)/app/administrator/users/new/_new-user-form.tsx` is
the reference implementation:

```tsx
const form = useZodForm<CreateUserInput>(createUserSchema, { defaultValues });

return (
  <Form {...form} schema={createUserSchema}>
    <form onSubmit={form.handleSubmit(onValid)} noValidate>
      <RequiredLegend />
      <FormField
        control={form.control}
        name="email"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("fields.email")}</FormLabel>
            <FormControl>
              <Input type="email" autoComplete="email" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {/* …more fields… */}
    </form>
  </Form>
);
```

On the screen: asterisks on the required fields (Email, Password), red borders
plus per-field messages on an invalid submit, a 409 mapped onto the email field,
and a banner reserved for form-level failures. The schema
(`createUserSchema` in `src/lib/validation/users.ts`) is the same object the
`POST /api/administrator/users` route enforces.

Refined schemas work the same way — e.g. `resetPasswordSchema` in
`auth.ts` adds a password-match `.refine()` that surfaces `passwordsMismatch` on
the confirm field, with the base object driving the required markers.

---

## Forms on this pattern

All app forms route through `useZodForm` + the `Form*` primitives:

**Admin — create:** users, roles, organizations, groups, permissions,
enterprise-apps, API keys.
**Admin — edit/settings:** roles, organizations, groups, enterprise-apps, email
templates.
**Account:** profile, preferences, security (password).
**Auth:** email/password sign-in, email/password sign-up, forgot-password,
reset-password (the `sign-in` / `sign-up` wrappers compose these).

---

## Testing

- **Component (RTL):** the auth and admin form tests assert required-field
  asterisks, invalid-submit → `aria-invalid` + `FormMessage` text, server-error
  mapping, and the happy path.
  `tests/component/settings-tab-remount.test.tsx` drives the real tab
  containers through save → tab switch → refresh for every form on
  `useSavedFormBaseline` and for the role Permissions editor (F-39).
- **Security:** the shared Zod schemas are exercised at the API boundary
  (`tests/security/handler-input-validation.test.ts`) to reject unknown keys,
  oversized, and malformed input — the same schemas the forms use.
- **Accessibility:** the Playwright + axe suite covers the migrated pages.
- **Locale parity:** the i18n parity test keeps every `validation.*` key present
  across all eight locales.

## Related

- Changelog: the `1.0.0` "System-wide form validation (React Hook Form + Zod)"
  entry in [CHANGELOG.md](../CHANGELOG.md).
- Accessibility and required-field handling: see
  [Architecture](./architecture.md) and the `required-asterisk` notes in the
  test guidance under [Testing](./testing.md).
