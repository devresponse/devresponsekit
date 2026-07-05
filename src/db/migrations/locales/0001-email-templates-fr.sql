-- locales/0001 — Seed fr (French) email templates.
--
-- Core 0001-initial-schema.sql seeded only the `en` rows for `password_reset`
-- and `test_email`, so a recipient with a `fr` `preferred_locale` would
-- otherwise fall back to English (the `resolveTemplate` query returns the `en`
-- row when the locale row is absent). Seed the localized rows so those users
-- get a French email. Companion files seed es (0002) and uk (0003).
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

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
  )
on conflict (key, locale) do nothing;
