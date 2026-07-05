-- locales/0003 — Seed uk (Ukrainian) email templates.
--
-- Follows locales/0002 (es). Core 0001-initial-schema.sql seeded only the `en`
-- rows for `password_reset` and `test_email`, so a recipient with a `uk`
-- `preferred_locale` would otherwise fall back to English (the `resolveTemplate`
-- query returns the `en` row when the locale row is absent). Seed the localized
-- rows so those users get a Ukrainian email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

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
  )
on conflict (key, locale) do nothing;
