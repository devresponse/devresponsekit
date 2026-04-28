import { redirect } from "next/navigation";
import { isSupportedLocale } from "@/config/i18n-config";

/** `/[locale]/app` redirects to the dashboard. */
export default async function AppIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  redirect(`/${safeLocale}/app/dashboard`);
}
