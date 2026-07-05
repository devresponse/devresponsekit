-- locales/0004 — Seed pt (Portuguese) email templates (all non-en rows).
--
-- The core migrations seed only the `en` base rows (0001-initial-schema.sql:
-- password_reset + test_email; 0006-email-verification-template.sql;
-- 0009-invitation-template.sql). A recipient whose `preferred_locale` is
-- `pt` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Portuguese email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

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
  ),
  (
    'email_verification',
    'pt',
    'Confirme o seu endereço de e-mail',
    '<p>Olá {{name}},</p><p>Obrigado por criar uma conta. Confirme o seu endereço de e-mail clicando na ligação abaixo. Esta ligação expira em breve.</p><p><a href="{{verifyUrl}}">Confirmar o seu e-mail</a></p><p>Se não criou uma conta, pode ignorar este e-mail com segurança.</p>',
    E'Olá {{name}},\n\nObrigado por criar uma conta. Abra a ligação abaixo para confirmar o seu endereço de e-mail. Esta ligação expira em breve.\n\n{{verifyUrl}}\n\nSe não criou uma conta, pode ignorar este e-mail com segurança.',
    'Email verification — pt translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'pt',
    'Você foi convidado a juntar-se a {{organizationName}}',
    '<p>Olá,</p><p>{{inviterName}} convidou você para se juntar a <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Aceitar o convite</a></p><p>Este convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.</p>',
    E'Olá,\n\n{{inviterName}} convidou você para se juntar a {{organizationName}}.\n\nAceitar o convite:\n{{acceptUrl}}\n\nEste convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.',
    'Convite para juntar-se a uma organização. Variáveis: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
