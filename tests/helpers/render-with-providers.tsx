// @vitest-environment jsdom
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { TEST_MESSAGES } from "./test-data-factories";

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  locale?: string;
  messages?: Record<string, unknown>;
}

/**
 * renderWithProviders
 *
 * Renders a component inside all required global providers:
 *   - `NextIntlClientProvider` so `useTranslations` resolves correctly.
 *
 * Use this for every component test to keep tests honest about the
 * accessible names and copy that users actually see.
 *
 * Alias: `renderWithIntl` (kept for backwards compatibility with existing
 * tests that import from `render-with-intl`).
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
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

/** @deprecated Use `renderWithProviders` instead. */
export const renderWithIntl = renderWithProviders;
