-- locales/0001 — Seed fr (French) email templates (all non-en rows).
--
-- The English BASE rows live in `locales/0000-email-templates-en.sql`. A
-- recipient whose `preferred_locale` is
-- `fr` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a French email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'fr',
    'Réinitialisez votre mot de passe',
    '<p>Bonjour {{name}},</p><p>Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le lien ci-dessous pour en choisir un nouveau. Ce lien expire bientôt.</p><p><a href="{{resetUrl}}">Réinitialiser votre mot de passe</a></p><p>Si vous n''êtes pas à l''origine de cette demande, vous pouvez ignorer cet e-mail.</p>',
    E'Bonjour {{name}},\n\nNous avons reçu une demande de réinitialisation de votre mot de passe. Ouvrez le lien ci-dessous pour en choisir un nouveau. Ce lien expire bientôt.\n\n{{resetUrl}}\n\nSi vous n''êtes pas à l''origine de cette demande, vous pouvez ignorer cet e-mail.',
    'Password reset email — fr translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'fr',
    'E-mail de test de {{appName}}',
    '<p>Ceci est un e-mail de test envoyé depuis l''espace Email de l''administrateur de {{appName}} par {{sentBy}}.</p><p>Si vous lisez ceci, l''envoi d''e-mails sortants fonctionne.</p>',
    E'Ceci est un e-mail de test envoyé depuis l''espace Email de l''administrateur de {{appName}} par {{sentBy}}.\n\nSi vous lisez ceci, l''envoi d''e-mails sortants fonctionne.',
    'Test email — fr translation. Variables: {{appName}}, {{sentBy}}.'
  ),
  (
    'email_verification',
    'fr',
    'Vérifiez votre adresse e-mail',
    '<p>Bonjour {{name}},</p><p>Merci d''avoir créé un compte. Veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous. Ce lien expire bientôt.</p><p><a href="{{verifyUrl}}">Vérifier votre e-mail</a></p><p>Si vous n''avez pas créé de compte, vous pouvez ignorer cet e-mail.</p>',
    E'Bonjour {{name}},\n\nMerci d''avoir créé un compte. Ouvrez le lien ci-dessous pour confirmer votre adresse e-mail. Ce lien expire bientôt.\n\n{{verifyUrl}}\n\nSi vous n''avez pas créé de compte, vous pouvez ignorer cet e-mail.',
    'Email verification — fr translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'fr',
    'Vous êtes invité à rejoindre {{organizationName}}',
    '<p>Bonjour,</p><p>{{inviterName}} vous a invité à rejoindre <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Accepter l''invitation</a></p><p>Cette invitation expire dans 7 jours. Si vous ne l''attendiez pas, vous pouvez ignorer cet e-mail.</p>',
    E'Bonjour,\n\n{{inviterName}} vous a invité à rejoindre {{organizationName}}.\n\nAccepter l''invitation :\n{{acceptUrl}}\n\nCette invitation expire dans 7 jours. Si vous ne l''attendiez pas, vous pouvez ignorer cet e-mail.',
    'Invitation à rejoindre une organisation. Variables : {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
