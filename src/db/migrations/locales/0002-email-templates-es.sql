-- locales/0002 — Seed es (Spanish) email templates (all non-en rows).
--
-- The English BASE rows live in `locales/0000-email-templates-en.sql`. A
-- recipient whose `preferred_locale` is
-- `es` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Spanish email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

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
  ),
  (
    'email_verification',
    'es',
    'Verifica tu dirección de correo electrónico',
    '<p>Hola {{name}},</p><p>Gracias por crear una cuenta. Confirma tu dirección de correo electrónico haciendo clic en el enlace de abajo. Este enlace caduca pronto.</p><p><a href="{{verifyUrl}}">Verificar tu correo</a></p><p>Si no creaste una cuenta, puedes ignorar este correo de forma segura.</p>',
    E'Hola {{name}},\n\nGracias por crear una cuenta. Abre el enlace de abajo para confirmar tu dirección de correo electrónico. Este enlace caduca pronto.\n\n{{verifyUrl}}\n\nSi no creaste una cuenta, puedes ignorar este correo de forma segura.',
    'Email verification — es translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'es',
    'Te han invitado a unirte a {{organizationName}}',
    '<p>Hola,</p><p>{{inviterName}} te ha invitado a unirte a <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Aceptar la invitación</a></p><p>Esta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.</p>',
    E'Hola,\n\n{{inviterName}} te ha invitado a unirte a {{organizationName}}.\n\nAceptar la invitación:\n{{acceptUrl}}\n\nEsta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.',
    'Invitación para unirse a una organización. Variables: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
