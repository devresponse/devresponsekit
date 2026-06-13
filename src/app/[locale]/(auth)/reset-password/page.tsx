import { useTranslations } from "next-intl";
import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

/**
 * Reset password page.
 *
 * Landing page for the emailed reset link (`?token=`). Better Auth
 * validates the one-time token when the new password is submitted; an
 * invalid/expired token shows a path back to `/forgot-password`.
 */
export default function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = use(params);
  const { token } = use(searchParams);
  const t = useTranslations("auth");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("resetPasswordTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm locale={locale} token={token ?? null} />
        </CardContent>
      </Card>
    </main>
  );
}
