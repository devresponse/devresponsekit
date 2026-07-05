-- locales/0007 — Seed ja (Japanese) email templates (all non-en rows).
--
-- The core migrations seed only the `en` base rows (0001-initial-schema.sql:
-- password_reset + test_email; 0006-email-verification-template.sql;
-- 0009-invitation-template.sql). A recipient whose `preferred_locale` is
-- `ja` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Japanese email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'ja',
    'パスワードをリセットする',
    '<p>{{name}} 様</p><p>パスワードのリセットのリクエストを受け付けました。新しいパスワードを設定するには、下のリンクをクリックしてください。このリンクはまもなく無効になります。</p><p><a href="{{resetUrl}}">パスワードをリセットする</a></p><p>このリクエストに心当たりがない場合は、このメールを無視していただいて問題ありません。</p>',
    E'{{name}} 様\n\nパスワードのリセットのリクエストを受け付けました。新しいパスワードを設定するには、下のリンクを開いてください。このリンクはまもなく無効になります。\n\n{{resetUrl}}\n\nこのリクエストに心当たりがない場合は、このメールを無視していただいて問題ありません。',
    'Password reset email — ja translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'ja',
    '{{appName}} からのテストメール',
    '<p>これは、{{sentBy}} が {{appName}} の管理者メールワークスペースから送信したテストメールです。</p><p>このメッセージが読める場合、送信メールの配信は正常に機能しています。</p>',
    E'これは、{{sentBy}} が {{appName}} の管理者メールワークスペースから送信したテストメールです。\n\nこのメッセージが読める場合、送信メールの配信は正常に機能しています。',
    'Test email — ja translation. Variables: {{appName}}, {{sentBy}}.'
  ),
  (
    'email_verification',
    'ja',
    'メールアドレスを確認してください',
    '<p>{{name}} 様</p><p>アカウントの作成ありがとうございます。下のリンクをクリックして、メールアドレスを確認してください。このリンクはまもなく無効になります。</p><p><a href="{{verifyUrl}}">メールアドレスを確認する</a></p><p>心当たりがない場合は、このメールを無視していただいて問題ありません。</p>',
    E'{{name}} 様\n\nアカウントの作成ありがとうございます。下のリンクを開いて、メールアドレスを確認してください。このリンクはまもなく無効になります。\n\n{{verifyUrl}}\n\n心当たりがない場合は、このメールを無視していただいて問題ありません。',
    'Email verification — ja translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'organization_invitation',
    'ja',
    '{{organizationName}} への招待',
    '<p>こんにちは。</p><p>{{inviterName}} があなたを <strong>{{organizationName}}</strong> に招待しました。</p><p><a href="{{acceptUrl}}">招待を受け入れる</a></p><p>この招待は 7 日後に無効になります。心当たりがない場合は、このメールを無視してください。</p>',
    E'こんにちは。\n\n{{inviterName}} があなたを {{organizationName}} に招待しました。\n\n招待を受け入れる：\n{{acceptUrl}}\n\nこの招待は 7 日後に無効になります。心当たりがない場合は、このメールを無視してください。',
    '組織への招待。変数：{{inviterName}}、{{organizationName}}、{{acceptUrl}}。'
  )
on conflict (key, locale) do nothing;
