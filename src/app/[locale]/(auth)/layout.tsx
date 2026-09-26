import type { ReactNode } from "react";
import { ClientMessagesProvider } from "@/components/i18n/client-messages-provider";

/**
 * AuthLayout
 *
 * The `(auth)` route group (sign-in, sign-up, password reset, invitation,
 * email verification) had no layout of its own; it exists to give the group's
 * client components their messages (F-123). The locale layout's provider
 * carries only the `locale` scope, so the sign-in and sign-up forms read the
 * `auth` and `validation` namespaces from this one, and the public pages do
 * not download them. It adds no markup: each page renders its own `<main>`.
 */
export default async function AuthLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <ClientMessagesProvider locale={locale} scope="auth">
      {children}
    </ClientMessagesProvider>
  );
}
