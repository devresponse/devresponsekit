-- 0008 — Seed zh (Simplified Chinese) email templates.
--
-- Follows 0007 (pt): 0001 seeded only the `en` rows for `password_reset` and
-- `test_email`. With Simplified Chinese added to the supported locales
-- (src/config/i18n-config.ts), a recipient with a `zh` `preferred_locale` would
-- otherwise fall back to English (the `resolveTemplate` query returns the `en`
-- row when the locale row is absent). Seed the localized rows so those users
-- get a Chinese email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'zh',
    '重置您的密码',
    '<p>您好 {{name}}，</p><p>我们收到了重置您密码的请求。请点击下方链接设置新密码。此链接将很快失效。</p><p><a href="{{resetUrl}}">重置您的密码</a></p><p>如果这不是您本人的操作，您可以安全地忽略此邮件。</p>',
    E'您好 {{name}}，\n\n我们收到了重置您密码的请求。请打开下方链接设置新密码。此链接将很快失效。\n\n{{resetUrl}}\n\n如果这不是您本人的操作，您可以安全地忽略此邮件。',
    'Password reset email — zh translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'zh',
    '来自 {{appName}} 的测试邮件',
    '<p>这是一封由 {{sentBy}} 从 {{appName}} 管理员邮件工作区发送的测试邮件。</p><p>如果您能看到此内容，说明出站邮件发送功能正常。</p>',
    E'这是一封由 {{sentBy}} 从 {{appName}} 管理员邮件工作区发送的测试邮件。\n\n如果您能看到此内容，说明出站邮件发送功能正常。',
    'Test email — zh translation. Variables: {{appName}}, {{sentBy}}.'
  )
on conflict (key, locale) do nothing;
