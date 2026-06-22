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

Schemas are **message-agnostic**: each Zod issue carries a stable
`validation.*` key (e.g. `z.email("email")`,
`.min(8, "passwordMin")`, `.max(128, "passwordMax")`) rather than prose. The
server only checks pass/fail, so those keys never reach an end user
untranslated; the client localizes them at render time (see `FormMessage`
below). Auth schemas are form-only — those forms call the Better Auth client
directly rather than an app route.

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
(`required`, `email`, `passwordMin`, `passwordMax`, `max`, `passwordsMismatch`,
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
