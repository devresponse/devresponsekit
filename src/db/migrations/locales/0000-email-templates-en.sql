-- locales/0000 — English BASE email templates (en locale, all templates).
--
-- The `en` rows are the FALLBACK every locale resolves to: `resolveTemplate`
-- returns the `en` row whenever a localized row is absent. So unlike the other
-- files in this directory, 0000 is ALWAYS applied — even when DB_MIGRATE_LOCALES
-- excludes the localized files (an English-only install still needs these). The
-- runner special-cases this one filename; see run-migrations.ts / migration-plan.ts.
--
-- Holds the `en` base row for every email template (password_reset, test_email,
-- email_verification, organization_invitation). Idempotent via `on conflict
-- (key, locale) do nothing`. Keep in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'en',
    'Reset your password',
    '<p>Hi {{name}},</p><p>We received a request to reset your password. Click the link below to choose a new one. This link expires shortly.</p><p><a href="{{resetUrl}}">Reset your password</a></p><p>If you did not request this, you can safely ignore this email.</p>',
    E'Hi {{name}},\n\nWe received a request to reset your password. Open the link below to choose a new one. This link expires shortly.\n\n{{resetUrl}}\n\nIf you did not request this, you can safely ignore this email.',
    'Sent for the forgot-password flow and the administrator "send reset email" action. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'en',
    'Test email from {{appName}}',
    '<p>This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.</p><p>If you can read this, outbound email delivery is working.</p>',
    E'This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.\n\nIf you can read this, outbound email delivery is working.',
    'Sent by the administrator "send test email" action. Variables: {{appName}}, {{sentBy}}.'
  ),
  (
    'email_verification',
    'en',
    'Verify your email address',
    '<p>Hi {{name}},</p><p>Thanks for creating an account. Please confirm your email address by clicking the link below. This link expires shortly.</p><p><a href="{{verifyUrl}}">Verify your email</a></p><p>If you did not create an account, you can safely ignore this email.</p>',
    E'Hi {{name}},\n\nThanks for creating an account. Open the link below to confirm your email address. This link expires shortly.\n\n{{verifyUrl}}\n\nIf you did not create an account, you can safely ignore this email.',
    'Sent at sign-up to confirm a new user''s email address. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'en',
    'You''re invited to join {{organizationName}}',
    '<p>Hi,</p><p>{{inviterName}} has invited you to join <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Accept the invitation</a></p><p>This invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.</p>',
    E'Hi,\n\n{{inviterName}} has invited you to join {{organizationName}}.\n\nAccept the invitation:\n{{acceptUrl}}\n\nThis invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.',
    'Sent when an administrator invites someone to an organization. Variables: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
