-- locales/0006 — Seed hi (Hindi) email templates (all non-en rows).
--
-- The English BASE rows live in `locales/0000-email-templates-en.sql`. A
-- recipient whose `preferred_locale` is
-- `hi` otherwise falls back to English (`resolveTemplate` returns the `en`
-- row when the locale row is absent). Seed every localized row here so those
-- users get a Hindi email.
--
-- One file per locale — excludable as a group via DB_MIGRATE_LOCALES. Keep in
-- sync with `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
-- Idempotent via `on conflict (key, locale) do nothing`.

insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'hi',
    'अपना पासवर्ड रीसेट करें',
    '<p>नमस्ते {{name}},</p><p>हमें आपका पासवर्ड रीसेट करने का अनुरोध प्राप्त हुआ है। नया पासवर्ड चुनने के लिए नीचे दिए गए लिंक पर क्लिक करें। यह लिंक शीघ्र ही समाप्त हो जाएगा।</p><p><a href="{{resetUrl}}">अपना पासवर्ड रीसेट करें</a></p><p>यदि आपने यह अनुरोध नहीं किया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>',
    E'नमस्ते {{name}},\n\nहमें आपका पासवर्ड रीसेट करने का अनुरोध प्राप्त हुआ है। नया पासवर्ड चुनने के लिए नीचे दिया गया लिंक खोलें। यह लिंक शीघ्र ही समाप्त हो जाएगा।\n\n{{resetUrl}}\n\nयदि आपने यह अनुरोध नहीं किया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।',
    'Password reset email — hi translation. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'hi',
    '{{appName}} से परीक्षण ईमेल',
    '<p>यह {{sentBy}} द्वारा {{appName}} व्यवस्थापक ईमेल कार्यक्षेत्र से भेजा गया एक परीक्षण ईमेल है।</p><p>यदि आप इसे पढ़ सकते हैं, तो आउटबाउंड ईमेल डिलीवरी काम कर रही है।</p>',
    E'यह {{sentBy}} द्वारा {{appName}} व्यवस्थापक ईमेल कार्यक्षेत्र से भेजा गया एक परीक्षण ईमेल है।\n\nयदि आप इसे पढ़ सकते हैं, तो आउटबाउंड ईमेल डिलीवरी काम कर रही है।',
    'Test email — hi translation. Variables: {{appName}}, {{sentBy}}.'
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
    'organization_invitation',
    'hi',
    'आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया गया है',
    '<p>नमस्ते,</p><p>{{inviterName}} ने आपको <strong>{{organizationName}}</strong> में शामिल होने के लिए आमंत्रित किया है।</p><p><a href="{{acceptUrl}}">आमंत्रण स्वीकार करें</a></p><p>यह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।</p>',
    E'नमस्ते,\n\n{{inviterName}} ने आपको {{organizationName}} में शामिल होने के लिए आमंत्रित किया है।\n\nआमंत्रण स्वीकार करें:\n{{acceptUrl}}\n\nयह आमंत्रण 7 दिनों में समाप्त हो जाएगा। यदि आपको इसकी अपेक्षा नहीं थी, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।',
    'किसी संगठन में शामिल होने का आमंत्रण। चर: {{inviterName}}, {{organizationName}}, {{acceptUrl}}।'
  )
on conflict (key, locale) do nothing;
