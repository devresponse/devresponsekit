-- locales/0001 — Seed fr / es / uk email templates (P3-8 / OUTBOX-2).
--
-- 0001 seeded only the `en` rows for `password_reset` and `test_email`, so a
-- recipient with a fr/es/uk `preferred_locale` fell back to English (the
-- `resolveTemplate` query returns the `en` row when the locale row is absent).
-- Seed the localized rows so those users get a localized email.
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
    'password_reset',
    'es',
    'Restablece tu contraseña',
    '<p>Hola {{name}},</p><p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el enlace de abajo para elegir una nueva. Este enlace caduca pronto.</p><p><a href="{{resetUrl}}">Restablecer tu contraseña</a></p><p>Si no solicitaste esto, puedes ignorar este correo de forma segura.</p>',
    E'Hola {{name}},\n\nRecibimos una solicitud para restablecer tu contraseña. Abre el enlace de abajo para elegir una nueva. Este enlace caduca pronto.\n\n{{resetUrl}}\n\nSi no solicitaste esto, puedes ignorar este correo de forma segura.',
    'Password reset email — es translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'password_reset',
    'uk',
    'Скиньте свій пароль',
    '<p>Вітаємо, {{name}}!</p><p>Ми отримали запит на скидання вашого пароля. Натисніть посилання нижче, щоб обрати новий. Це посилання незабаром стане недійсним.</p><p><a href="{{resetUrl}}">Скинути пароль</a></p><p>Якщо ви не надсилали цей запит, можете проігнорувати цей лист.</p>',
    E'Вітаємо, {{name}}!\n\nМи отримали запит на скидання вашого пароля. Відкрийте посилання нижче, щоб обрати новий. Це посилання незабаром стане недійсним.\n\n{{resetUrl}}\n\nЯкщо ви не надсилали цей запит, можете проігнорувати цей лист.',
    'Password reset email — uk translation. Variables: {{name}}, {{resetUrl}}.'
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
    'test_email',
    'es',
    'Correo de prueba de {{appName}}',
    '<p>Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.</p><p>Si puedes leer esto, el envío de correos salientes funciona.</p>',
    E'Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.\n\nSi puedes leer esto, el envío de correos salientes funciona.',
    'Test email — es translation. Variables: {{appName}}, {{sentBy}}.'
  ),
  (
    'test_email',
    'uk',
    'Тестовий лист від {{appName}}',
    '<p>Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.</p><p>Якщо ви це читаєте, надсилання вихідних листів працює.</p>',
    E'Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.\n\nЯкщо ви це читаєте, надсилання вихідних листів працює.',
    'Test email — uk translation. Variables: {{appName}}, {{sentBy}}.'
  )
on conflict (key, locale) do nothing;
