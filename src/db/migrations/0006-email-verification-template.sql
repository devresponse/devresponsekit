-- 0006 — Seed the `email_verification` email template (en base row).
--
-- AUTH-4 adds email verification at sign-up: Better Auth's `sendVerificationEmail`
-- hook (src/lib/auth.ts) renders this template through the outbox (specs.md §35).
-- 0001 seeded only `password_reset` and `test_email`; this adds the `en` base
-- row for the new key. The non-`en` rows live in
-- `locales/0008-email-verification-locales.sql` (excludable via DB_MIGRATE_LOCALES).
--
-- Keep in sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`
-- (the code-level fallback). Idempotent via `on conflict (key, locale) do nothing`,
-- so it is safe on a DB where an admin already authored the row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'email_verification',
    'en',
    'Verify your email address',
    '<p>Hi {{name}},</p><p>Thanks for creating an account. Please confirm your email address by clicking the link below. This link expires shortly.</p><p><a href="{{verifyUrl}}">Verify your email</a></p><p>If you did not create an account, you can safely ignore this email.</p>',
    E'Hi {{name}},\n\nThanks for creating an account. Open the link below to confirm your email address. This link expires shortly.\n\n{{verifyUrl}}\n\nIf you did not create an account, you can safely ignore this email.',
    'Sent at sign-up to confirm a new user''s email address. Variables: {{name}}, {{verifyUrl}}.'
  )
on conflict (key, locale) do nothing;
