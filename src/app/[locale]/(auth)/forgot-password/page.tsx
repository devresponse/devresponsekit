import { useTranslations } from "next-intl";
import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

/**
 * Forgot password page.
 *
 * Hosts the reset-request form. The emailed link (rendered and recorded
 * through the outbox pipeline, specs.md §35) lands on the localized
 * `/reset-password` page with the one-time token.
 */
export default function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  const t = useTranslations("auth");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("forgotPassword")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm redirectTo={`/${locale}/reset-password`} />
        </CardContent>
      </Card>
    </main>
  );
}
