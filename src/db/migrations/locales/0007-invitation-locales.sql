-- locales/0007 — Non-English rows for the `organization_invitation` template
-- (en base row: 0009-invitation-template.sql). Data-only and idempotent;
-- excludable via DB_MIGRATE_LOCALES. Keep in sync with the `translations`
-- block in `src/lib/email/templates.ts`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'organization_invitation',
    'fr',
    'Vous êtes invité à rejoindre {{organizationName}}',
    '<p>Bonjour,</p><p>{{inviterName}} vous a invité à rejoindre <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Accepter l''invitation</a></p><p>Cette invitation expire dans 7 jours. Si vous ne l''attendiez pas, vous pouvez ignorer cet e-mail.</p>',
    E'Bonjour,\n\n{{inviterName}} vous a invité à rejoindre {{organizationName}}.\n\nAccepter l''invitation :\n{{acceptUrl}}\n\nCette invitation expire dans 7 jours. Si vous ne l''attendiez pas, vous pouvez ignorer cet e-mail.',
    'Invitation à rejoindre une organisation. Variables : {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  ),
  (
    'organization_invitation',
    'es',
    'Te han invitado a unirte a {{organizationName}}',
    '<p>Hola,</p><p>{{inviterName}} te ha invitado a unirte a <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Aceptar la invitación</a></p><p>Esta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.</p>',
    E'Hola,\n\n{{inviterName}} te ha invitado a unirte a {{organizationName}}.\n\nAceptar la invitación:\n{{acceptUrl}}\n\nEsta invitación caduca en 7 días. Si no la esperabas, puedes ignorar este correo de forma segura.',
    'Invitación para unirse a una organización. Variables: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  ),
  (
    'organization_invitation',
    'uk',
    'Вас запрошено приєднатися до {{organizationName}}',
    '<p>Вітаємо!</p><p>{{inviterName}} запрошує вас приєднатися до <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Прийняти запрошення</a></p><p>Це запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.</p>',
    E'Вітаємо!\n\n{{inviterName}} запрошує вас приєднатися до {{organizationName}}.\n\nПрийняти запрошення:\n{{acceptUrl}}\n\nЦе запрошення діє 7 днів. Якщо ви не очікували його, можете проігнорувати цей лист.',
    'Запрошення приєднатися до організації. Змінні: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  ),
  (
    'organization_invitation',
    'pt',
    'Você foi convidado a juntar-se a {{organizationName}}',
    '<p>Olá,</p><p>{{inviterName}} convidou você para se juntar a <strong>{{organizationName}}</strong>.</p><p><a href="{{acceptUrl}}">Aceitar o convite</a></p><p>Este convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.</p>',
    E'Olá,\n\n{{inviterName}} convidou você para se juntar a {{organizationName}}.\n\nAceitar o convite:\n{{acceptUrl}}\n\nEste convite expira em 7 dias. Se você não o esperava, pode ignorar este e-mail com segurança.',
    'Convite para juntar-se a uma organização. Variáveis: {{inviterName}}, {{organizationName}}, {{acceptUrl}}.'
  ),
  (
    'organization_invitation',
    'zh',
    '邀请您加入 {{organizationName}}',
    '<p>您好，</p><p>{{inviterName}} 邀请您加入 <strong>{{organizationName}}</strong>。</p><p><a href="{{acceptUrl}}">接受邀请</a></p><p>此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。</p>',
    E'您好，\n\n{{inviterName}} 邀请您加入 {{organizationName}}。\n\n接受邀请：\n{{acceptUrl}}\n\n此邀请将在 7 天后失效。如果您并未预期收到此邮件，可以安全地忽略它。',
    '邀请加入组织。变量：{{inviterName}}、{{organizationName}}、{{acceptUrl}}。'
  ),
  (
    'organization_invitation',
    'hi',
    'आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया गया है',
    '<p>नमस्ते,</p><p>{{inviterName}} ने आपको <strong>{{organizationName}}</strong> में शामिल होने के लिए आमंत्रित किया है।</p><p><a href="{{acceptUrl}}">आमंत्रण स्वीकार करें</a></p><p>यह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>',
    E'नमस्ते,\n\n{{inviterName}} ने आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया है।\n\nआमंत्रण स्वीकार करें:\n{{acceptUrl}}\n\nयह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।',
    'किसी संगठन में शामिल होने का आमंत्रण। चर: {{inviterName}}, {{organizationName}}, {{acceptUrl}}।'
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
