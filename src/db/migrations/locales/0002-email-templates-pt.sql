-- locales/0002 — Seed pt (Portuguese) email templates.
--
-- Follows locales/0001 (fr/es/uk): 0001 seeded only the `en` rows for `password_reset`
-- and `test_email`. With Portuguese added to the supported locales
-- (src/config/i18n-config.ts), a recipient with a `pt` `preferred_locale` would
-- otherwise fall back to English (the `resolveTemplate` query returns the `en`
-- row when the locale row is absent). Seed the localized rows so those users
-- get a Portuguese email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'pt',
    'Redefina a sua palavra-passe',
    '<p>Olá {{name}},</p><p>Recebemos um pedido para redefinir a sua palavra-passe. Clique na ligação abaixo para escolher uma nova. Esta ligação expira em breve.</p><p><a href="{{resetUrl}}">Redefinir a sua palavra-passe</a></p><p>Se não foi você que fez este pedido, pode ignorar este e-mail com segurança.</p>',
    E'Olá {{name}},\n\nRecebemos um pedido para redefinir a sua palavra-passe. Abra a ligação abaixo para escolher uma nova. Esta ligação expira em breve.\n\n{{resetUrl}}\n\nSe não foi você que fez este pedido, pode ignorar este e-mail com segurança.',
    'Password reset email — pt translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'pt',
    'E-mail de teste de {{appName}}',
    '<p>Este é um e-mail de teste enviado a partir do espaço de Email do administrador de {{appName}} por {{sentBy}}.</p><p>Se consegue ler isto, o envio de e-mails está a funcionar.</p>',
    E'Este é um e-mail de teste enviado a partir do espaço de Email do administrador de {{appName}} por {{sentBy}}.\n\nSe consegue ler isto, o envio de e-mails está a funcionar.',
    'Test email — pt translation. Variables: {{appName}}, {{sentBy}}.'
  )
on conflict (key, locale) do nothing;
