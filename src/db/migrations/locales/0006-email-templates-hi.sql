-- locales/0006 — Seed hi (Hindi) email templates.
--
-- Follows locales/0005 (zh): core 0001-initial-schema.sql seeded only the `en`
-- rows for `password_reset` and
-- `test_email`. With Hindi added to the supported locales
-- (src/config/i18n-config.ts), a recipient with a `hi` `preferred_locale` would
-- otherwise fall back to English (the `resolveTemplate` query returns the `en`
-- row when the locale row is absent). Seed the localized rows so those users
-- get a Hindi email.
--
-- Keep this copy in sync with `DEFAULT_EMAIL_TEMPLATES` in
-- `src/lib/email/templates.ts` (the code-level fallback). Idempotent via
-- `on conflict (key, locale) do nothing`, so it is safe on a DB where an admin
-- already authored a localized row.

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
  )
on conflict (key, locale) do nothing;
