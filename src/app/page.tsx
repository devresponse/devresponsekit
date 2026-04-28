import { redirect } from "next/navigation";
import { defaultLocale } from "@/config/i18n-config";

/**
 * Root index.
 *
 * Browser hits to `/` always include a locale segment in the rest of the
 * app, so we redirect to the default locale. Production deployments may
 * detect `Accept-Language` here in the future.
 */
export default function RootIndex() {
  redirect(`/${defaultLocale}`);
}
