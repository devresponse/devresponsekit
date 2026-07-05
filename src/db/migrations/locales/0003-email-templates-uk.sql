-- locales/0003 — Seed uk (Ukrainian) email templates (all non-en rows).
--
-- The core migrations seed only the `en` base rows (0001-initial-schema.sql:
-- password_reset + test_email; 0006-email-verification-template.sql;
-- 0009-invitation-template.sql). A recipient whose `preferred_locale` is
-- `uk` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Ukrainian email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
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
    'uk',
    'Тестовий лист від {{appName}}',
    '<p>Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.</p><p>Якщо ви це читаєте, надсилання вихідних листів працює.</p>',
    E'Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.\n\nЯкщо ви це читаєте, надсилання вихідних листів працює.',
    'Test email — uk translation. Variables: {{appName}}, {{sentBy}}.'
  ),
  (
    'email_verification',
    'uk',
    'Підтвердьте свою електронну адресу',
    '<p>Вітаємо, {{name}}!</p><p>Дякуємо за створення облікового запису. Підтвердьте свою електронну адресу, натиснувши посилання нижче. Це посилання незабаром стане недійсним.</p><p><a href="{{verifyUrl}}">Підтвердити електронну адресу</a></p><p>Якщо ви не створювали обліковий запис, можете проігнорувати цей лист.</p>',
    E'Вітаємо, {{name}}!\n\nДякуємо за створення облікового запису. Відкрийте посилання нижче, щоб підтвердити свою електронну адресу. Це посилання незабаром стане недійсним.\n\n{{verifyUrl}}\n\nЯкщо ви не створювали обліковий запис, можете проігнорувати цей лист.',
    'Email verification — uk translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'uk',
    'Вас запрошено приєднатися до {{organizationName}}',
    '<p>Вітаємо!</p><p>{{inviterName}} запрошує вас приєднатися до <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Прийняти запрошення</a></p><p>Це запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.</p>',
    E'Вітаємо!\n\n{{inviterName}} запрошує вас приєднатися до {{organizationName}}.\n\nПрийняти запрошення:\n{{acceptUrl}}\n\nЦе запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.',
    'Запрошення приєднатися до організації. Змінні: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  )
on conflict (key, locale) do nothing;
