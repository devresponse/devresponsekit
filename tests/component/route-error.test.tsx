// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { RouteError } from "@/components/observability/route-error";

/**
 * F-110: the Support ID a localized error boundary shows must be a value an
 * operator can find. With the browser SDK off (no NEXT_PUBLIC_SENTRY_DSN) that
 * is Next's digest, which the server's `route.unhandled_error` line carries as
 * `err.digest`. With it on, it is the id of the event actually sent to Sentry.
 *
 * `captureException` returns a fresh random id whether or not the SDK will
 * send anything, including with `enabled: false` and with no client at all.
 * The boundary used to show that id, so on a deployment without Sentry the
 * user quoted an id that existed nowhere and the digest was never shown.
 *
 * This runs the REAL SDK, since a mock that returns "" for a disabled SDK is
 * how the wrong premise went unnoticed. As in sentry-replay.test.ts,
 * `@sentry/nextjs` is served by `@sentry/browser` (Vitest resolves it to the
 * server build), and `init` gets a transport that records envelopes instead
 * of posting them.
 */
const bodies = vi.hoisted(() => [] as (string | Uint8Array)[]);

vi.mock("@sentry/nextjs", async () => {
  const browser = await import("@sentry/browser");
  const { createTransport } = await import("@sentry/core");
  type InitOptions = NonNullable<Parameters<typeof browser.init>[0]>;
  return {
    ...browser,
    init: (options: InitOptions) =>
      browser.init({
        ...options,
        defaultIntegrations: false,
        transport: (transportOptions) =>
          createTransport(transportOptions, (request) => {
            bodies.push(request.body);
            return Promise.resolve({ statusCode: 200 });
          }),
      }),
  };
});

// Passthrough translator: returns the message key so assertions are stable.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const DIGEST = "2436375093";

function renderBoundary(digest?: string) {
  const error = Object.assign(new Error("render failed"), digest ? { digest } : {});
  return render(<RouteError error={error} reset={() => undefined} />);
}

afterEach(async () => {
  await Sentry.getClient()?.close(0);
  bodies.length = 0;
});

describe("RouteError Support ID (F-110)", () => {
  it("shows the digest when the SDK is initialised disabled, as with no DSN", async () => {
    // What src/instrumentation-client.ts does without NEXT_PUBLIC_SENTRY_DSN.
    Sentry.init({ dsn: undefined, enabled: false });
    expect(Sentry.isEnabled()).toBe(false);
    // The premise the old code missed: capture still returns an id.
    expect(Sentry.captureException(new Error("probe"))).toMatch(/^[0-9a-f]{32}$/);

    renderBoundary(DIGEST);
    await waitFor(() => expect(document.querySelector("code")?.textContent).toBe(DIGEST));
    await Sentry.flush(100);
    expect(bodies).toHaveLength(0);
  });

  it("shows no Support ID when the SDK is disabled and the error has no digest", () => {
    Sentry.init({ dsn: undefined, enabled: false });
    renderBoundary();
    // RTL's render runs the effect inside act(), so its state update has landed.
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    expect(screen.queryByText(/supportId/)).toBeNull();
  });

  it("shows the id of the event it sent to Sentry when the SDK is enabled", async () => {
    Sentry.init({ dsn: "https://public@o1.ingest.sentry.io/1" });
    expect(Sentry.isEnabled()).toBe(true);

    renderBoundary(DIGEST);
    await waitFor(() =>
      expect(document.querySelector("code")?.textContent).toMatch(/^[0-9a-f]{32}$/),
    );
    const shown = document.querySelector("code")?.textContent;

    await Sentry.flush(1000);
    const { parseEnvelope } = await import("@sentry/core");
    const sent = bodies.map((body) => (parseEnvelope(body)[0] as { event_id?: string }).event_id);
    expect(sent).toEqual([shown]);
  });
});
