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
 * Built-in defaults. Keep in sync with the seeded templates in the initial
 * schema `0001-initial-schema.sql` (the `en` rows),
 * `0006-email-template-locales.sql` (the fr/es/uk rows),
 * `0007-email-template-locales-pt.sql` (the pt rows), and
 * `0008-email-template-locales-zh.sql` (the zh rows).
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
    },
  },
] as const;

export type EmailTemplateKey = "password_reset" | "test_email";

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
