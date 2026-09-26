import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";
import { pickClientMessages, type ClientMessageScope } from "@/i18n/client-messages";
import { getViewerFormatPreferences } from "@/lib/format/viewer-format.server";

/**
 * The app's `NextIntlClientProvider`, mounted by the locale layout and by the
 * `(auth)` and `(secure)` group layouts (F-123). A Server Component: it
 * serializes only `scope`'s namespaces into the page (see
 * `src/i18n/client-messages.ts`), never the whole catalog.
 *
 * F-37: the zone is the one next-intl's request config returns, passed
 * explicitly so the client formats in the zone the server used. Both lookups
 * are memoized per request, so a nested provider costs no extra read.
 */
export async function ClientMessagesProvider({
  locale,
  scope,
  children,
}: {
  locale: string;
  scope: ClientMessageScope;
  children: ReactNode;
}) {
  const messages = await getMessages({ locale });
  const { timeZone } = await getViewerFormatPreferences();

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={pickClientMessages(messages, scope)}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
