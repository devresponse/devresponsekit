/**
 * Email template catalog + renderer (specs.md §35).
 *
 * Templates live in `app_email_templates` and are editable through the
 * administrator Email workspace. This module holds the code-level
 * DEFAULTS — the renderer falls back to these when a (key, locale) row
 * is missing, so a deleted or never-seeded row can never break a flow.
 *
 * Kept free of `server-only` and runtime imports (like
 * `src/lib/admin/permissions.ts`) so the seed script and unit tests can
 * import it under plain Node.
 */

/** The locale-varying parts of a template. `en` is the base + final fallback. */
export interface LocalizedEmailContent {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export interface EmailTemplateDefinition extends LocalizedEmailContent {
  key: string;
  description: string;
  /** Variable names the template understands, for the editor UI. */
  variables: ReadonlyArray<string>;
  /**
   * Non-`en` translations, keyed by locale. The top-level fields are the `en`
   * base; {@link getDefaultEmailTemplate} overlays the requested locale's
   * content when present. Keep these aligned with the supported locales in
   * `src/config/i18n-config.ts`.
   */
  translations?: Readonly<Record<string, LocalizedEmailContent>>;
}

/**
 * Built-in defaults. Keep in sync with the seeded rows in the SQL migrations,
 * which now live entirely under `locales/` — one file per locale, each carrying
 * all four templates for that locale: the `en` BASE in
 * `locales/0000-email-templates-en.sql` (always applied) and the localized rows
 * in `locales/0001`–`0007` (fr, es, uk, pt, zh, hi, ja).
 */
export const DEFAULT_EMAIL_TEMPLATES: ReadonlyArray<EmailTemplateDefinition> = [
  {
    key: "password_reset",
    subject: "Reset your password",
    bodyHtml:
      "<p>Hi {{name}},</p>" +
      "<p>We received a request to reset your password. Click the link below to choose a new one. This link expires shortly.</p>" +
      '<p><a href="{{resetUrl}}">Reset your password</a></p>' +
      "<p>If you did not request this, you can safely ignore this email.</p>",
    bodyText:
      "Hi {{name}},\n\n" +
      "We received a request to reset your password. Open the link below to choose a new one. This link expires shortly.\n\n" +
      "{{resetUrl}}\n\n" +
      "If you did not request this, you can safely ignore this email.",
    description:
      'Sent for the forgot-password flow and the administrator "send reset email" action.',
    variables: ["name", "resetUrl"],
    translations: {
      fr: {
        subject: "Réinitialisez votre mot de passe",
        bodyHtml:
          "<p>Bonjour {{name}},</p>" +
          "<p>Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le lien ci-dessous pour en choisir un nouveau. Ce lien expire bientôt.</p>" +
          '<p><a href="{{resetUrl}}">Réinitialiser votre mot de passe</a></p>' +
          "<p>Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.</p>",
        bodyText:
          "Bonjour {{name}},\n\n" +
          "Nous avons reçu une demande de réinitialisation de votre mot de passe. Ouvrez le lien ci-dessous pour en choisir un nouveau. Ce lien expire bientôt.\n\n" +
          "{{resetUrl}}\n\n" +
          "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.",
      },
      es: {
        subject: "Restablece tu contraseña",
        bodyHtml:
          "<p>Hola {{name}},</p>" +
          "<p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el enlace de abajo para elegir una nueva. Este enlace caduca pronto.</p>" +
          '<p><a href="{{resetUrl}}">Restablecer tu contraseña</a></p>' +
          "<p>Si no solicitaste esto, puedes ignorar este correo de forma segura.</p>",
        bodyText:
          "Hola {{name}},\n\n" +
          "Recibimos una solicitud para restablecer tu contraseña. Abre el enlace de abajo para elegir una nueva. Este enlace caduca pronto.\n\n" +
          "{{resetUrl}}\n\n" +
          "Si no solicitaste esto, puedes ignorar este correo de forma segura.",
      },
      uk: {
        subject: "Скиньте свій пароль",
        bodyHtml:
          "<p>Вітаємо, {{name}}!</p>" +
          "<p>Ми отримали запит на скидання вашого пароля. Натисніть посилання нижче, щоб обрати новий. Це посилання незабаром стане недійсним.</p>" +
          '<p><a href="{{resetUrl}}">Скинути пароль</a></p>' +
          "<p>Якщо ви не надсилали цей запит, можете проігнорувати цей лист.</p>",
        bodyText:
          "Вітаємо, {{name}}!\n\n" +
          "Ми отримали запит на скидання вашого пароля. Відкрийте посилання нижче, щоб обрати новий. Це посилання незабаром стане недійсним.\n\n" +
          "{{resetUrl}}\n\n" +
          "Якщо ви не надсилали цей запит, можете проігнорувати цей лист.",
      },
      pt: {
        subject: "Redefina a sua palavra-passe",
        bodyHtml:
          "<p>Olá {{name}},</p>" +
          "<p>Recebemos um pedido para redefinir a sua palavra-passe. Clique na ligação abaixo para escolher uma nova. Esta ligação expira em breve.</p>" +
          '<p><a href="{{resetUrl}}">Redefinir a sua palavra-passe</a></p>' +
          "<p>Se não foi você que fez este pedido, pode ignorar este e-mail com segurança.</p>",
        bodyText:
          "Olá {{name}},\n\n" +
          "Recebemos um pedido para redefinir a sua palavra-passe. Abra a ligação abaixo para escolher uma nova. Esta ligação expira em breve.\n\n" +
          "{{resetUrl}}\n\n" +
          "Se não foi você que fez este pedido, pode ignorar este e-mail com segurança.",
      },
      zh: {
        subject: "重置您的密码",
        bodyHtml:
          "<p>您好 {{name}}，</p>" +
          "<p>我们收到了重置您密码的请求。请点击下方链接设置新密码。此链接将很快失效。</p>" +
          '<p><a href="{{resetUrl}}">重置您的密码</a></p>' +
          "<p>如果这不是您本人的操作，您可以安全地忽略此邮件。</p>",
        bodyText:
          "您好 {{name}}，\n\n" +
          "我们收到了重置您密码的请求。请打开下方链接设置新密码。此链接将很快失效。\n\n" +
          "{{resetUrl}}\n\n" +
          "如果这不是您本人的操作，您可以安全地忽略此邮件。",
      },
      hi: {
        subject: "अपना पासवर्ड रीसेट करें",
        bodyHtml:
          "<p>नमस्ते {{name}},</p>" +
          "<p>हमें आपका पासवर्ड रीसेट करने का अनुरोध प्राप्त हुआ है। नया पासवर्ड चुनने के लिए नीचे दिए गए लिंक पर क्लिक करें। यह लिंक शीघ्र ही समाप्त हो जाएगा।</p>" +
          '<p><a href="{{resetUrl}}">अपना पासवर्ड रीसेट करें</a></p>' +
          "<p>यदि आपने यह अनुरोध नहीं किया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>",
        bodyText:
          "नमस्ते {{name}},\n\n" +
          "हमें आपका पासवर्ड रीसेट करने का अनुरोध प्राप्त हुआ है। नया पासवर्ड चुनने के लिए नीचे दिया गया लिंक खोलें। यह लिंक शीघ्र ही समाप्त हो जाएगा।\n\n" +
          "{{resetUrl}}\n\n" +
          "यदि आपने यह अनुरोध नहीं किया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।",
      },
      ja: {
        subject: "パスワードをリセットする",
        bodyHtml:
          "<p>{{name}} 様</p>" +
          "<p>パスワードのリセットのリクエストを受け付けました。新しいパスワードを設定するには、下のリンクをクリックしてください。このリンクはまもなく無効になります。</p>" +
          '<p><a href="{{resetUrl}}">パスワードをリセットする</a></p>' +
          "<p>このリクエストに心当たりがない場合は、このメールを無視していただいて問題ありません。</p>",
        bodyText:
          "{{name}} 様\n\n" +
          "パスワードのリセットのリクエストを受け付けました。新しいパスワードを設定するには、下のリンクを開いてください。このリンクはまもなく無効になります。\n\n" +
          "{{resetUrl}}\n\n" +
          "このリクエストに心当たりがない場合は、このメールを無視していただいて問題ありません。",
      },
    },
  },
  {
    key: "test_email",
    subject: "Test email from {{appName}}",
    bodyHtml:
      "<p>This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.</p>" +
      "<p>If you can read this, outbound email delivery is working.</p>",
    bodyText:
      "This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.\n\n" +
      "If you can read this, outbound email delivery is working.",
    description: 'Sent by the administrator "send test email" action.',
    variables: ["appName", "sentBy"],
    translations: {
      fr: {
        subject: "E-mail de test de {{appName}}",
        bodyHtml:
          "<p>Ceci est un e-mail de test envoyé depuis l'espace Email de l'administrateur de {{appName}} par {{sentBy}}.</p>" +
          "<p>Si vous lisez ceci, l'envoi d'e-mails sortants fonctionne.</p>",
        bodyText:
          "Ceci est un e-mail de test envoyé depuis l'espace Email de l'administrateur de {{appName}} par {{sentBy}}.\n\n" +
          "Si vous lisez ceci, l'envoi d'e-mails sortants fonctionne.",
      },
      es: {
        subject: "Correo de prueba de {{appName}}",
        bodyHtml:
          "<p>Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.</p>" +
          "<p>Si puedes leer esto, el envío de correos salientes funciona.</p>",
        bodyText:
          "Este es un correo de prueba enviado desde el espacio de Email del administrador de {{appName}} por {{sentBy}}.\n\n" +
          "Si puedes leer esto, el envío de correos salientes funciona.",
      },
      uk: {
        subject: "Тестовий лист від {{appName}}",
        bodyHtml:
          "<p>Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.</p>" +
          "<p>Якщо ви це читаєте, надсилання вихідних листів працює.</p>",
        bodyText:
          "Це тестовий лист, надісланий з робочого простору Email адміністратора {{appName}} користувачем {{sentBy}}.\n\n" +
          "Якщо ви це читаєте, надсилання вихідних листів працює.",
      },
      pt: {
        subject: "E-mail de teste de {{appName}}",
        bodyHtml:
          "<p>Este é um e-mail de teste enviado a partir do espaço de Email do administrador de {{appName}} por {{sentBy}}.</p>" +
          "<p>Se consegue ler isto, o envio de e-mails está a funcionar.</p>",
        bodyText:
          "Este é um e-mail de teste enviado a partir do espaço de Email do administrador de {{appName}} por {{sentBy}}.\n\n" +
          "Se consegue ler isto, o envio de e-mails está a funcionar.",
      },
      zh: {
        subject: "来自 {{appName}} 的测试邮件",
        bodyHtml:
          "<p>这是一封由 {{sentBy}} 从 {{appName}} 管理员邮件工作区发送的测试邮件。</p>" +
          "<p>如果您能看到此内容，说明出站邮件发送功能正常。</p>",
        bodyText:
          "这是一封由 {{sentBy}} 从 {{appName}} 管理员邮件工作区发送的测试邮件。\n\n" +
          "如果您能看到此内容，说明出站邮件发送功能正常。",
      },
      hi: {
        subject: "{{appName}} से परीक्षण ईमेल",
        bodyHtml:
          "<p>यह {{sentBy}} द्वारा {{appName}} व्यवस्थापक ईमेल कार्यक्षेत्र से भेजा गया एक परीक्षण ईमेल है।</p>" +
          "<p>यदि आप इसे पढ़ सकते हैं, तो आउटबाउंड ईमेल डिलीवरी काम कर रही है।</p>",
        bodyText:
          "यह {{sentBy}} द्वारा {{appName}} व्यवस्थापक ईमेल कार्यक्षेत्र से भेजा गया एक परीक्षण ईमेल है।\n\n" +
          "यदि आप इसे पढ़ सकते हैं, तो आउटबाउंड ईमेल डिलीवरी काम कर रही है।",
      },
      ja: {
        subject: "{{appName}} からのテストメール",
        bodyHtml:
          "<p>これは、{{sentBy}} が {{appName}} の管理者メールワークスペースから送信したテストメールです。</p>" +
          "<p>このメッセージが読める場合、送信メールの配信は正常に機能しています。</p>",
        bodyText:
          "これは、{{sentBy}} が {{appName}} の管理者メールワークスペースから送信したテストメールです。\n\n" +
          "このメッセージが読める場合、送信メールの配信は正常に機能しています。",
      },
    },
  },
  {
    key: "email_verification",
    subject: "Verify your email address",
    bodyHtml:
      "<p>Hi {{name}},</p>" +
      "<p>Thanks for creating an account. Please confirm your email address by clicking the link below. This link expires shortly.</p>" +
      '<p><a href="{{verifyUrl}}">Verify your email</a></p>' +
      "<p>If you did not create an account, you can safely ignore this email.</p>",
    bodyText:
      "Hi {{name}},\n\n" +
      "Thanks for creating an account. Open the link below to confirm your email address. This link expires shortly.\n\n" +
      "{{verifyUrl}}\n\n" +
      "If you did not create an account, you can safely ignore this email.",
    description: "Sent at sign-up to confirm a new user's email address.",
    variables: ["name", "verifyUrl"],
    translations: {
      fr: {
        subject: "Vérifiez votre adresse e-mail",
        bodyHtml:
          "<p>Bonjour {{name}},</p>" +
          "<p>Merci d'avoir créé un compte. Veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous. Ce lien expire bientôt.</p>" +
          '<p><a href="{{verifyUrl}}">Vérifier votre e-mail</a></p>' +
          "<p>Si vous n'avez pas créé de compte, vous pouvez ignorer cet e-mail.</p>",
        bodyText:
          "Bonjour {{name}},\n\n" +
          "Merci d'avoir créé un compte. Ouvrez le lien ci-dessous pour confirmer votre adresse e-mail. Ce lien expire bientôt.\n\n" +
          "{{verifyUrl}}\n\n" +
          "Si vous n'avez pas créé de compte, vous pouvez ignorer cet e-mail.",
      },
      es: {
        subject: "Verifica tu dirección de correo electrónico",
        bodyHtml:
          "<p>Hola {{name}},</p>" +
          "<p>Gracias por crear una cuenta. Confirma tu dirección de correo electrónico haciendo clic en el enlace de abajo. Este enlace caduca pronto.</p>" +
          '<p><a href="{{verifyUrl}}">Verificar tu correo</a></p>' +
          "<p>Si no creaste una cuenta, puedes ignorar este correo de forma segura.</p>",
        bodyText:
          "Hola {{name}},\n\n" +
          "Gracias por crear una cuenta. Abre el enlace de abajo para confirmar tu dirección de correo electrónico. Este enlace caduca pronto.\n\n" +
          "{{verifyUrl}}\n\n" +
          "Si no creaste una cuenta, puedes ignorar este correo de forma segura.",
      },
      uk: {
        subject: "Підтвердьте свою електронну адресу",
        bodyHtml:
          "<p>Вітаємо, {{name}}!</p>" +
          "<p>Дякуємо за створення облікового запису. Підтвердьте свою електронну адресу, натиснувши посилання нижче. Це посилання незабаром стане недійсним.</p>" +
          '<p><a href="{{verifyUrl}}">Підтвердити електронну адресу</a></p>' +
          "<p>Якщо ви не створювали обліковий запис, можете проігнорувати цей лист.</p>",
        bodyText:
          "Вітаємо, {{name}}!\n\n" +
          "Дякуємо за створення облікового запису. Відкрийте посилання нижче, щоб підтвердити свою електронну адресу. Це посилання незабаром стане недійсним.\n\n" +
          "{{verifyUrl}}\n\n" +
          "Якщо ви не створювали обліковий запис, можете проігнорувати цей лист.",
      },
      pt: {
        subject: "Confirme o seu endereço de e-mail",
        bodyHtml:
          "<p>Olá {{name}},</p>" +
          "<p>Obrigado por criar uma conta. Confirme o seu endereço de e-mail clicando na ligação abaixo. Esta ligação expira em breve.</p>" +
          '<p><a href="{{verifyUrl}}">Confirmar o seu e-mail</a></p>' +
          "<p>Se não criou uma conta, pode ignorar este e-mail com segurança.</p>",
        bodyText:
          "Olá {{name}},\n\n" +
          "Obrigado por criar uma conta. Abra a ligação abaixo para confirmar o seu endereço de e-mail. Esta ligação expira em breve.\n\n" +
          "{{verifyUrl}}\n\n" +
          "Se não criou uma conta, pode ignorar este e-mail com segurança.",
      },
      zh: {
        subject: "验证您的电子邮件地址",
        bodyHtml:
          "<p>您好 {{name}}，</p>" +
          "<p>感谢您创建账户。请点击下方链接确认您的电子邮件地址。此链接将很快失效。</p>" +
          '<p><a href="{{verifyUrl}}">验证您的电子邮件</a></p>' +
          "<p>如果您没有创建账户，您可以安全地忽略此邮件。</p>",
        bodyText:
          "您好 {{name}}，\n\n" +
          "感谢您创建账户。请打开下方链接确认您的电子邮件地址。此链接将很快失效。\n\n" +
          "{{verifyUrl}}\n\n" +
          "如果您没有创建账户，您可以安全地忽略此邮件。",
      },
      hi: {
        subject: "अपना ईमेल पता सत्यापित करें",
        bodyHtml:
          "<p>नमस्ते {{name}},</p>" +
          "<p>खाता बनाने के लिए धन्यवाद। कृपया नीचे दिए गए लिंक पर क्लिक करके अपना ईमेल पता पुष्टि करें। यह लिंक शीघ्र ही समाप्त हो जाएगा।</p>" +
          '<p><a href="{{verifyUrl}}">अपना ईमेल सत्यापित करें</a></p>' +
          "<p>यदि आपने खाता नहीं बनाया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>",
        bodyText:
          "नमस्ते {{name}},\n\n" +
          "खाता बनाने के लिए धन्यवाद। अपना ईमेल पता पुष्टि करने के लिए नीचे दिया गया लिंक खोलें। यह लिंक शीघ्र ही समाप्त हो जाएगा।\n\n" +
          "{{verifyUrl}}\n\n" +
          "यदि आपने खाता नहीं बनाया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।",
      },
      ja: {
        subject: "メールアドレスを確認してください",
        bodyHtml:
          "<p>{{name}} 様</p>" +
          "<p>アカウントの作成ありがとうございます。下のリンクをクリックして、メールアドレスを確認してください。このリンクはまもなく無効になります。</p>" +
          '<p><a href="{{verifyUrl}}">メールアドレスを確認する</a></p>' +
          "<p>心当たりがない場合は、このメールを無視していただいて問題ありません。</p>",
        bodyText:
          "{{name}} 様\n\n" +
          "アカウントの作成ありがとうございます。下のリンクを開いて、メールアドレスを確認してください。このリンクはまもなく無効になります。\n\n" +
          "{{verifyUrl}}\n\n" +
          "心当たりがない場合は、このメールを無視していただいて問題ありません。",
      },
    },
  },
  {
    key: "organization_invitation",
    subject: "You're invited to join {{organizationName}}",
    bodyHtml:
      "<p>Hi,</p>" +
      "<p>{{inviterName}} has invited you to join <strong>{{organizationName}}</strong>.</p>" +
      '<p><a href="{{acceptUrl}}">Accept the invitation</a></p>' +
      "<p>This invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.</p>",
    bodyText:
      "Hi,\n\n" +
      "{{inviterName}} has invited you to join {{organizationName}}.\n\n" +
      "Accept the invitation:\n{{acceptUrl}}\n\n" +
      "This invitation expires in 7 days. If you were not expecting it, you can safely ignore this email.",
    description: "Sent when an administrator invites someone to an organization (0008).",
    variables: ["inviterName", "organizationName", "acceptUrl"],
    translations: {
      fr: {
        subject: "Vous êtes invité à rejoindre {{organizationName}}",
        bodyHtml:
          "<p>Bonjour,</p>" +
          "<p>{{inviterName}} vous a invité à rejoindre <strong>{{organizationName}}</strong>.</p>" +
          '<p><a href="{{acceptUrl}}">Accepter l’invitation</a></p>' +
          "<p>Cette invitation expire dans 7 jours. Si vous ne l’attendiez pas, vous pouvez ignorer cet e-mail.</p>",
        bodyText:
          "Bonjour,\n\n" +
          "{{inviterName}} vous a invité à rejoindre {{organizationName}}.\n\n" +
          "Accepter l’invitation :\n{{acceptUrl}}\n\n" +
          "Cette invitation expire dans 7 jours. Si vous ne l’attendiez pas, vous pouvez ignorer cet e-mail.",
      },
      es: {
        subject: "Te han invitado a unirte a {{organizationName}}",
        bodyHtml:
          "<p>Hola,</p>" +
          "<p>{{inviterName}} te ha invitado a unirte a <strong>{{organizationName}}</strong>.</p>" +
          '<p><a href="{{acceptUrl}}">Aceptar la invitación</a></p>' +
          "<p>Esta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.</p>",
        bodyText:
          "Hola,\n\n" +
          "{{inviterName}} te ha invitado a unirte a {{organizationName}}.\n\n" +
          "Aceptar la invitación:\n{{acceptUrl}}\n\n" +
          "Esta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.",
      },
      uk: {
        subject: "Вас запрошено приєднатися до {{organizationName}}",
        bodyHtml:
          "<p>Вітаємо!</p>" +
          "<p>{{inviterName}} запрошує вас приєднатися до <strong>{{organizationName}}</strong>.</p>" +
          '<p><a href="{{acceptUrl}}">Прийняти запрошення</a></p>' +
          "<p>Це запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.</p>",
        bodyText:
          "Вітаємо!\n\n" +
          "{{inviterName}} запрошує вас приєднатися до {{organizationName}}.\n\n" +
          "Прийняти запрошення:\n{{acceptUrl}}\n\n" +
          "Це запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.",
      },
      pt: {
        subject: "Você foi convidado a juntar-se a {{organizationName}}",
        bodyHtml:
          "<p>Olá,</p>" +
          "<p>{{inviterName}} convidou você para se juntar a <strong>{{organizationName}}</strong>.</p>" +
          '<p><a href="{{acceptUrl}}">Aceitar o convite</a></p>' +
          "<p>Este convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.</p>",
        bodyText:
          "Olá,\n\n" +
          "{{inviterName}} convidou você para se juntar a {{organizationName}}.\n\n" +
          "Aceitar o convite:\n{{acceptUrl}}\n\n" +
          "Este convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.",
      },
      zh: {
        subject: "邀请您加入 {{organizationName}}",
        bodyHtml:
          "<p>您好，</p>" +
          "<p>{{inviterName}} 邀请您加入 <strong>{{organizationName}}</strong>。</p>" +
          '<p><a href="{{acceptUrl}}">接受邀请</a></p>' +
          "<p>此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。</p>",
        bodyText:
          "您好，\n\n" +
          "{{inviterName}} 邀请您加入 {{organizationName}}。\n\n" +
          "接受邀请：\n{{acceptUrl}}\n\n" +
          "此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。",
      },
      hi: {
        subject: "आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया गया है",
        bodyHtml:
          "<p>नमस्ते,</p>" +
          "<p>{{inviterName}} ने आपको <strong>{{organizationName}}</strong> में शामिल होने के लिए आमंत्रित किया है।</p>" +
          '<p><a href="{{acceptUrl}}">आमंत्रण स्वीकार करें</a></p>' +
          "<p>यह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>",
        bodyText:
          "नमस्ते,\n\n" +
          "{{inviterName}} ने आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया है।\n\n" +
          "आमंत्रण स्वीकार करें:\n{{acceptUrl}}\n\n" +
          "यह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।",
      },
      ja: {
        subject: "{{organizationName}} への招待",
        bodyHtml:
          "<p>こんにちは。</p>" +
          "<p>{{inviterName}} があなたを <strong>{{organizationName}}</strong> に招待しました。</p>" +
          '<p><a href="{{acceptUrl}}">招待を受け入れる</a></p>' +
          "<p>この招待は 7 日後に無効になります。心当たりがない場合は、このメールを無視してください。</p>",
        bodyText:
          "こんにちは。\n\n" +
          "{{inviterName}} があなたを {{organizationName}} に招待しました。\n\n" +
          "招待を受け入れる：\n{{acceptUrl}}\n\n" +
          "この招待は 7 日後に無効になります。心当たりがない場合は、このメールを無視してください。",
      },
    },
  },
] as const;

export type EmailTemplateKey =
  "password_reset" | "test_email" | "email_verification" | "organization_invitation";

/**
 * Returns the code-level default for `key`, with the requested `locale`'s
 * translation overlaid when one exists (otherwise the `en` base). `locale`
 * defaults to `"en"` — kept as a literal so this module stays import-free and
 * usable from the seed script and unit tests under plain Node.
 */
export function getDefaultEmailTemplate(
  key: string,
  locale: string = "en",
): EmailTemplateDefinition | undefined {
  const template = DEFAULT_EMAIL_TEMPLATES.find((t) => t.key === key);
  if (!template || locale === "en") return template;
  const localized = template.translations?.[locale];
  return localized ? { ...template, ...localized } : template;
}

/** Minimal HTML entity escape for variable VALUES interpolated into HTML bodies. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Substitutes `{{variable}}` placeholders.
 *
 * Security contract:
 *   - In `html` mode every variable VALUE is entity-escaped, so user-
 *     controlled values (display names, emails) can never inject markup
 *     into a template. Reset URLs are generated by Better Auth, not by
 *     users, and survive escaping intact inside `href="..."`.
 *   - Unknown placeholders are left verbatim so an admin editing a
 *     template sees `{{typo}}` in the outbox instead of silent loss.
 */
export function renderEmailTemplate(
  template: string,
  variables: Record<string, string>,
  mode: "html" | "text",
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (placeholder, name: string) => {
    const value = variables[name];
    if (value === undefined) return placeholder;
    return mode === "html" ? escapeHtml(value) : value;
  });
}
