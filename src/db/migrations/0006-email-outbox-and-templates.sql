-- 0006-email-outbox-and-templates.sql
--
-- Email subsystem (specs.md §35):
--
--   1. `app_email_templates` — editable templates keyed by
--      (key, locale). Seeded with the built-in defaults below;
--      administrators edit them through the Email workspace. The
--      runtime falls back to the code-level defaults in
--      `src/lib/email/templates.ts` when a key/locale row is missing,
--      so deleting a row can never break a flow.
--
--   2. `app_outbox` — every outbound email is recorded here BEFORE any
--      delivery attempt (outbox-first). Delivery through a configured
--      third-party provider (Resend / Mailgun) updates the row to
--      `sent` / `failed`; with no provider configured the row is kept
--      as `logged` so local/dev/CI environments have a complete,
--      inspectable record without sending anything.
--
--   3. New administrator permissions `admin.email.read` /
--      `admin.email.manage`, granted to `superuser` like 0005 so
--      migration-only databases see the Email workspace immediately.
--
-- Idempotent: `create table if not exists` + `on conflict do nothing`.

create table if not exists app_email_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  locale text not null default 'en',
  subject text not null,
  body_html text not null,
  body_text text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key, locale)
);

create table if not exists app_outbox (
  id uuid primary key default gen_random_uuid(),
  template_key text,
  to_email text not null,
  from_email text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'logged')),
  provider text,
  provider_message_id text,
  error text,
  related_better_auth_user_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_app_outbox_created_at_desc
  on app_outbox (created_at desc);
create index if not exists idx_app_outbox_status
  on app_outbox (status);

-- Default templates. Keep keys + variables in sync with
-- `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
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
  )
on conflict (key, locale) do nothing;

-- Email administrator permissions. Keep in sync with
-- `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts`.
insert into app_permissions (key, description) values
  ('admin.email.read', 'Read the email outbox and templates'),
  ('admin.email.manage', 'Edit email templates and send test emails')
on conflict (key) do nothing;

-- Re-grant every registered permission to the superuser role on the
-- default org (same pattern as 0005) so the new keys are picked up.
insert into app_role_permissions (role_id, permission_id)
select r.id, p.id
from app_roles r
join app_organizations o on o.id = r.organization_id
cross join app_permissions p
where o.slug = 'default'
  and r.key = 'superuser'
on conflict do nothing;
