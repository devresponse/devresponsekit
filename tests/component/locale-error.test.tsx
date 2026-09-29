// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LocaleError from "@/app/[locale]/error";
import frMessages from "@/messages/fr.json";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-68: `[locale]/error.tsx` catches a throw from a route-group layout —
 * `(secure)/layout.tsx` reads the session and the user's organizations — which
 * the group's own error.tsx cannot catch. Before it existed, such a throw fell
 * through to the English-only `global-error.tsx`. It renders inside
 * `[locale]/layout.tsx`'s providers, so the fallback is localized.
 */
const captureException = vi.fn((_error: unknown) => "evt-123");
// `captureClientError` keeps the event id only while the SDK is enabled
// (F-110); with it on, the Support ID is that id rather than the digest.
vi.mock("@sentry/nextjs", () => ({
  captureException: (error: unknown) => captureException(error),
  isEnabled: () => true,
}));

beforeEach(() => captureException.mockClear());
afterEach(() => vi.clearAllMocks());

describe("[locale]/error.tsx (F-68)", () => {
  it("renders the localized route error with a Support ID and a retry that re-fetches", async () => {
    // Next's error boundary passes all three props. `reset` only clears the
    // error state and re-renders the cached payload, which still holds a
    // server-side layout throw; `retry` refreshes the router first. The button
    // must call `retry`, or "Try again" can never recover from the layout
    // failures this boundary exists for.
    const reset = vi.fn();
    const retry = vi.fn();
    const error = Object.assign(new Error("layout failed"), { digest: "d-1" });
    const nextProps = { error, reset, retry };
    renderWithIntl(<LocaleError {...nextProps} />, {
      locale: "fr",
      messages: frMessages,
    });

    expect(
      screen.getByRole("heading", { name: frMessages.errorBoundary.title }),
    ).toBeInTheDocument();
    expect(await screen.findByText("evt-123")).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledWith(error);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: frMessages.errorBoundary.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });
});
