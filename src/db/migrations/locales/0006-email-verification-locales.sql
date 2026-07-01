-- locales/0006 — Seed fr / es / uk / pt / zh / hi / ja `email_verification` rows.
--
-- Companion to the core `0006-email-verification-template.sql` (the `en` base).
-- AUTH-4's sign-up verification email; a recipient whose `preferred_locale` is
-- non-en gets a localized message (`resolveTemplate` falls back to the `en` row
-- when the locale row is absent). Excludable via DB_MIGRATE_LOCALES.
--
-- Keep in sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`, so it is safe on a DB
-- where an admin already authored a localized row.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'email_verification',
    'fr',
    'Vérifiez votre adresse e-mail',
    '<p>Bonjour {{name}},</p><p>Merci d''avoir créé un compte. Veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous. Ce lien expire bientôt.</p><p><a href="{{verifyUrl}}">Vérifier votre e-mail</a></p><p>Si vous n''avez pas créé de compte, vous pouvez ignorer cet e-mail.</p>',
    E'Bonjour {{name}},\n\nMerci d''avoir créé un compte. Ouvrez le lien ci-dessous pour confirmer votre adresse e-mail. Ce lien expire bientôt.\n\n{{verifyUrl}}\n\nSi vous n''avez pas créé de compte, vous pouvez ignorer cet e-mail.',
    'Email verification — fr translation. Variables: {{name}}, {{verifyUrl}}.'
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
    'email_verification',
    'uk',
    'Підтвердьте свою електронну адресу',
    '<p>Вітаємо, {{name}}!</p><p>Дякуємо за створення облікового запису. Підтвердьте свою електронну адресу, натиснувши посилання нижче. Це посилання незабаром стане недійсним.</p><p><a href="{{verifyUrl}}">Підтвердити електронну адресу</a></p><p>Якщо ви не створювали обліковий запис, можете проігнорувати цей лист.</p>',
    E'Вітаємо, {{name}}!\n\nДякуємо за створення облікового запису. Відкрийте посилання нижче, щоб підтвердити свою електронну адресу. Це посилання незабаром стане недійсним.\n\n{{verifyUrl}}\n\nЯкщо ви не створювали обліковий запис, можете проігнорувати цей лист.',
    'Email verification — uk translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'email_verification',
    'pt',
    'Confirme o seu endereço de e-mail',
    '<p>Olá {{name}},</p><p>Obrigado por criar uma conta. Confirme o seu endereço de e-mail clicando na ligação abaixo. Esta ligação expira em breve.</p><p><a href="{{verifyUrl}}">Confirmar o seu e-mail</a></p><p>Se não criou uma conta, pode ignorar este e-mail com segurança.</p>',
    E'Olá {{name}},\n\nObrigado por criar uma conta. Abra a ligação abaixo para confirmar o seu endereço de e-mail. Esta ligação expira em breve.\n\n{{verifyUrl}}\n\nSe não criou uma conta, pode ignorar este e-mail com segurança.',
    'Email verification — pt translation. Variables: {{name}}, {{verifyUrl}}.'
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
    'email_verification',
    'hi',
    'अपना ईमेल पता सत्यापित करें',
    '<p>नमस्ते {{name}},</p><p>खाता बनाने के लिए धन्यवाद। कृपया नीचे दिए गए लिंक पर क्लिक करके अपना ईमेल पता पुष्टि करें। यह लिंक शीघ्र ही समाप्त हो जाएगा।</p><p><a href="{{verifyUrl}}">अपना ईमेल सत्यापित करें</a></p><p>यदि आपने खाता नहीं बनाया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>',
    E'नमस्ते {{name}},\n\nखाता बनाने के लिए धन्यवाद। अपना ईमेल पता पुष्टि करने के लिए नीचे दिया गया लिंक खोलें। यह लिंक शीघ्र ही समाप्त हो जाएगा।\n\n{{verifyUrl}}\n\nयदि आपने खाता नहीं बनाया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।',
    'Email verification — hi translation. Variables: {{name}}, {{verifyUrl}}.'
  ),
  (
    'email_verification',
    'ja',
    'メールアドレスを確認してください',
    '<p>{{name}} 様</p><p>アカウントの作成ありがとうございます。下のリンクをクリックして、メールアドレスを確認してください。このリンクはまもなく無効になります。</p><p><a href="{{verifyUrl}}">メールアドレスを確認する</a></p><p>心当たりがない場合は、このメールを無視していただいて問題ありません。</p>',
    E'{{name}} 様\n\nアカウントの作成ありがとうございます。下のリンクを開いて、メールアドレスを確認してください。このリンクはまもなく無効になります。\n\n{{verifyUrl}}\n\n心当たりがない場合は、このメールを無視していただいて問題ありません。',
    'Email verification — ja translation. Variables: {{name}}, {{verifyUrl}}.'
  )
on conflict (key, locale) do nothing;
