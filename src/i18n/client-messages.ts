import type { AbstractIntlMessages } from "next-intl";

/**
 * The message namespaces each route group's CLIENT components read (F-123).
 *
 * The locale layout used to hand the whole catalog to its
 * `NextIntlClientProvider`, so every page carried every string in its HTML:
 * an anonymous visitor to the landing page or sign-in downloaded the ~30 KB
 * `administrator` namespace and everything else with it. Server components
 * never needed that: `getTranslations` and a server `useTranslations` read the
 * request config's catalog directly. Only client components read the
 * provider's messages, so each layout now serializes just the namespaces the
 * client components under it use:
 *
 *   - `locale`: `[locale]/layout.tsx`. The public pages, and the [locale]
 *     `error.tsx` and `not-found.tsx`, which render inside this layout's
 *     provider only, wherever the throw or `notFound()` came from.
 *   - `auth`: `(auth)/layout.tsx`. Sign-in, sign-up, password reset,
 *     invitation acceptance and email verification.
 *   - `secure`: `(secure)/layout.tsx`. The signed-in shell, account, docs,
 *     help and the Administrator console.
 *
 * A nested `NextIntlClientProvider` REPLACES its parent's messages, it does
 * not merge them (use-intl's `IntlProvider`), and on the server a provider
 * given no `messages` loads the whole catalog again. So each nested scope
 * repeats the `locale` scope and every layout passes its pick explicitly.
 *
 * `tests/unit/client-message-scopes.test.ts` walks each group's import graph
 * and fails when a client component reads a namespace its scope leaves out.
 */
const LOCALE_SCOPE = ["common", "errorBoundary", "notFound"] as const;

export const CLIENT_MESSAGE_SCOPES = {
  locale: LOCALE_SCOPE,
  auth: [...LOCALE_SCOPE, "auth", "validation"],
  secure: [
    ...LOCALE_SCOPE,
    "shell",
    "validation",
    "account",
    "docs",
    "help",
    "administrator",
    "errors",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ClientMessageScope = keyof typeof CLIENT_MESSAGE_SCOPES;

/** The top-level namespaces of `messages` that `scope`'s client components read. */
export function pickClientMessages(
  messages: AbstractIntlMessages,
  scope: ClientMessageScope,
): AbstractIntlMessages {
  const picked: AbstractIntlMessages = {};
  for (const namespace of CLIENT_MESSAGE_SCOPES[scope]) {
    const value = messages[namespace];
    if (value !== undefined) picked[namespace] = value;
  }
  return picked;
}
