-- locales/0005 — Seed zh (Simplified Chinese) email templates (all non-en rows).
--
-- The core migrations seed only the `en` base rows (0001-initial-schema.sql:
-- password_reset + test_email; 0006-email-verification-template.sql;
-- 0009-invitation-template.sql). A recipient whose `preferred_locale` is
-- `zh` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Simplified Chinese email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

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
  ),
  (
    'email_verification',
    'zh',
    '验证您的电子邮件地址',
    '<p>您好 {{name}}，</p><p>感谢您创建账户。请点击下方链接确认您的电子邮件地址。此链接将很快失效。</p><p><a href="{{verifyUrl}}">验证您的电子邮件</a></p><p>如果您没有创建账户，您可以安全地忽略此邮件。</p>',
    E'您好 {{name}}，\n\n感谢您创建账户。请打开下方链接确认您的电子邮件地址。此链接将很快失效。\n\n{{verifyUrl}}\n\n如果您没有创建账户，您可以安全地忽略此邮件。',
    'Email verification — zh translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'zh',
    '邀请您加入 {{organizationName}}',
    '<p>您好，</p><p>{{inviterName}} 邀请您加入 <strong>{{organizationName}}</strong>。</p><p><a href="{{acceptUrl}}">接受邀请</a></p><p>此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。</p>',
    E'您好，\n\n{{inviterName}} 邀请您加入 {{organizationName}}。\n\n接受邀请：\n{{acceptUrl}}\n\n此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。',
    '邀请加入组织。变量：{{inviterName}}、{{organizationName}}、{{acceptUrl}}。'
  )
on conflict (key, locale) do nothing;
