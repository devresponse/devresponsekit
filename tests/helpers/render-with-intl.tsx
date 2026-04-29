// @vitest-environment jsdom
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { TEST_MESSAGES } from "./test-data-factories";

interface RenderWithIntlOptions extends Omit<RenderOptions, "wrapper"> {
  locale?: string;
  messages?: Record<string, unknown>;
}

/**
 * Renders a component inside `NextIntlClientProvider` so any
 * `useTranslations` call resolves against the real English messages.
 *
 * Use this for every component test — it keeps tests honest about the
 * accessible names and copy users see.
 */
export function renderWithIntl(
  ui: ReactElement,
  options: RenderWithIntlOptions = {},
): RenderResult {
  const { locale = "en", messages = TEST_MESSAGES, ...rest } = options;
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...rest });
}
