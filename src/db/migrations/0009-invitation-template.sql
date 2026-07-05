-- 0009 — Seed the `organization_invitation` email template (en base row).
--
-- Sent by the administrator invitations API (0008) through the outbox
-- (specs.md §35). The non-`en` rows live in
-- `locales/0007-invitation-locales.sql` (excludable via DB_MIGRATE_LOCALES).
--
-- Keep in sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`
-- (the code-level fallback). Idempotent via `on conflict (key, locale) do
-- nothing`, so it is safe on a DB where an admin already authored the row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'organization_invitation',
    'en',
    'You''re invited to join {{organizationName}}',
    '<p>Hi,</p><p>{{inviterName}} has invited you to join <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Accept the invitation</a></p><p>This invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.</p>',
    E'Hi,\n\n{{inviterName}} has invited you to join {{organizationName}}.\n\nAccept the invitation:\n{{acceptUrl}}\n\nThis invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.',
    'Sent when an administrator invites someone to an organization. Variables: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
