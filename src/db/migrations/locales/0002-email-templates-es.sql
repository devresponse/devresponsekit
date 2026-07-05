-- locales/0002 — Seed es (Spanish) email templates.
--
-- Follows locales/0001 (fr). Core 0001-initial-schema.sql seeded only the `en`
-- rows for `password_reset` and `test_email`, so a recipient with an `es`
-- `preferred_locale` would otherwise fall back to English (the `resolveTemplate`
-- query returns the `en` row when the locale row is absent). Seed the localized
-- rows so those users get a Spanish email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'es',
    'Restablece tu contraseña',
    '<p>Hola {{name}},</p><p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el enlace de abajo para elegir una nueva. Este enlace caduca pronto.</p><p><a href="{{resetUrl}}">Restablecer tu contraseña</a></p><p>Si no solicitaste esto, puedes ignorar este correo de forma segura.</p>',
    E'Hola {{name}},\n\nRecibimos una solicitud para restablecer tu contraseña. Abre el enlace de abajo para elegir una nueva. Este enlace caduca pronto.\n\n{{resetUrl}}\n\nSi no solicitaste esto, puedes ignorar este correo de forma segura.',
    'Password reset email — es translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'es',
    'Correo de prueba de {{appName}}',
    '<p>Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.</p><p>Si puedes leer esto, el envío de correos salientes funciona.</p>',
    E'Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.\n\nSi puedes leer esto, el envío de correos salientes funciona.',
    'Test email — es translation. Variables: {{appName}}, {{sentBy}}.'
  )
on conflict (key, locale) do nothing;
