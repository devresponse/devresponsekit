-- locales/0005 — Seed ja (Japanese) email templates.
--
-- Follows locales/0004 (hi): 0001 seeded only the `en` rows for `password_reset` and
-- `test_email`. With Japanese added to the supported locales
-- (src/config/i18n-config.ts), a recipient with a `ja` `preferred_locale` would
-- otherwise fall back to English (the `resolveTemplate` query returns the `en`
-- row when the locale row is absent). Seed the localized rows so those users
-- get a Japanese email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

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
  )
on conflict (key, locale) do nothing;
