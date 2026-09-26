// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider, type IntlError } from "next-intl";
import type { ReactNode } from "react";
import NotFound from "@/app/[locale]/not-found";
import { ApiKeyRevealDialog } from "@/components/api-keys/api-key-reveal";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { ClientMessagesProvider } from "@/components/i18n/client-messages-provider";
import { CLIENT_MESSAGE_SCOPES, type ClientMessageScope } from "@/i18n/client-messages";
import enMessages from "@/messages/en.json";

/**
 * F-123: the provider each layout mounts serializes only its scope's
 * namespaces, and the client components under that scope still find every
 * key they read. `tests/unit/client-message-scopes.test.ts` proves the second
 * part for every client module by walking the import graph; this renders a
 * few of them for real, through the real provider.
 */
const getMessages = vi.fn(async (_options: { locale: string }) => enMessages);
vi.mock("next-intl/server", () => ({
  getMessages: (options: { locale: string }) => getMessages(options),
}));
// The real lookup reads the request's session cookie; there is no request here.
vi.mock("@/lib/format/viewer-format.server", () => ({
  getViewerFormatPreferences: async () => ({
    timeZone: "America/Toronto",
    dateFormat: "system",
    numberLocale: null,
  }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { requestPasswordReset: vi.fn() },
}));

beforeEach(() => getMessages.mockClear());

/**
 * Renders `ui` under `scope`'s provider, nested (as in the app) inside an
 * outer provider that holds the FULL catalog and records every intl error the
 * render raises. A nested provider replaces the messages it inherits (the
 * negative control below proves it), so a key found under it came from the
 * scope.
 */
async function renderInScope(scope: ClientMessageScope, ui: ReactNode): Promise<string[]> {
  const errors: string[] = [];
  const scoped = await ClientMessagesProvider({ locale: "en", scope, children: ui });
  render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error: IntlError) => errors.push(error.message)}
    >
      {scoped}
    </NextIntlClientProvider>,
  );
  return errors;
}

describe("ClientMessagesProvider (F-123)", () => {
  it.each(Object.keys(CLIENT_MESSAGE_SCOPES) as ClientMessageScope[])(
    "serializes only the %s scope's namespaces, in the viewer's zone",
    async (scope) => {
      const element = await ClientMessagesProvider({ locale: "fr", scope, children: null });

      expect(getMessages).toHaveBeenCalledWith({ locale: "fr" });
      expect(Object.keys(element.props.messages).sort()).toEqual(
        [...CLIENT_MESSAGE_SCOPES[scope]].sort(),
      );
      expect(element.props.messages.common).toEqual(enMessages.common);
      expect(element.props).toMatchObject({ locale: "fr", timeZone: "America/Toronto" });
    },
  );

  it("leaves the Administrator console's strings out of the public and sign-in pages", async () => {
    for (const scope of ["locale", "auth"] as const) {
      const element = await ClientMessagesProvider({ locale: "en", scope, children: null });
      expect(element.props.messages).not.toHaveProperty("administrator");
    }
    const secure = await ClientMessagesProvider({ locale: "en", scope: "secure", children: null });
    expect(secure.props.messages.administrator).toEqual(enMessages.administrator);
  });

  it("gives a client component under each scope every key it reads", async () => {
    expect(await renderInScope("locale", <NotFound />)).toEqual([]);
    expect(screen.getByRole("heading", { name: enMessages.notFound.title })).toBeInTheDocument();

    expect(
      await renderInScope("auth", <ForgotPasswordForm redirectTo="/en/reset-password" />),
    ).toEqual([]);
    expect(screen.getByRole("button", { name: enMessages.auth.sendResetLink })).toBeInTheDocument();

    // The reveal dialog takes its namespace as a prop: both callers' resolve.
    for (const namespace of ["account.apiKeys.reveal", "administrator.apiKeys.reveal"] as const) {
      expect(
        await renderInScope(
          "secure",
          <ApiKeyRevealDialog secret="drk_test_secret" onClose={() => {}} namespace={namespace} />,
        ),
      ).toEqual([]);
    }
  });

  it("replaces the inherited messages, so a namespace the scope omits goes missing (negative control)", async () => {
    // The reset form under the bare locale scope: the outer provider holds
    // every namespace, and the form still misses its `auth` keys, because a
    // nested provider replaces the messages it inherits rather than merging.
    const errors = await renderInScope(
      "locale",
      <ForgotPasswordForm redirectTo="/en/reset-password" />,
    );
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/^MISSING_MESSAGE: .*auth/)]),
    );
  });
});
