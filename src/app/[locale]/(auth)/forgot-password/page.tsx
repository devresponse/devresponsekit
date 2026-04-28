import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Forgot password placeholder.
 *
 * Better Auth manages the actual reset flow at `/api/auth/*`. This page
 * exposes a localized entry point and will be expanded with a request
 * form in a follow-up — kept minimal here to satisfy the route-region
 * inventory in §28.3 without coupling to internal Better Auth endpoints.
 */
export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("forgotPassword")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-neutral-600">
            Password reset request flow is intentionally minimal in this scaffold.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
