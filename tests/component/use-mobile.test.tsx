// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * `useIsMobile` hydration contract (review #102).
 *
 * The hook used to be `useState(getIsMobile)`. A lazy `useState`
 * initializer runs AGAIN on the client during hydration, so on a narrow
 * viewport the server HTML said "desktop" and the very first client render
 * said "mobile" — a guaranteed hydration mismatch on every mobile secure
 * page (React discards the server tree, the shell re-renders, a console
 * error is logged).
 *
 * These tests reproduce that with a matchMedia that MATCHES, so they fail
 * the moment the `useSyncExternalStore` + `getServerSnapshot` pair is
 * traded back for a lazy initializer:
 *   1. server render must be "desktop" even though `window.matchMedia`
 *      exists and matches (jsdom keeps `window` defined);
 *   2. hydrating that HTML must not log a hydration error;
 *   3. after hydration the hook must report the real value and react to
 *      media-query changes.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let matches = false;

function installMatchMedia() {
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: Listener) => listeners.add(cb),
      removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function Probe() {
  return <span data-testid="probe">{useIsMobile() ? "mobile" : "desktop"}</span>;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  listeners.clear();
  matches = true; // a NARROW viewport — the case that used to mismatch
  installMatchMedia();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("useIsMobile", () => {
  it("renders the desktop branch on the server even when the media query matches", () => {
    // `renderToString` never runs effects, so this is exactly what the
    // browser receives as HTML. A lazy `useState(getIsMobile)` returns
    // "mobile" here because jsdom defines `window`.
    expect(renderToString(<Probe />)).toContain("desktop");
  });

  it("hydrates the server HTML without a mismatch, then reports the real value", async () => {
    const html = renderToString(<Probe />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const onRecoverableError = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { hydrateRoot } = await import("react-dom/client");
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <Probe />, { onRecoverableError });
    });

    // No hydration error was recovered from, and none was logged.
    expect(onRecoverableError).not.toHaveBeenCalled();
    const hydrationLogs = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /hydrat/i.test(m));
    expect(hydrationLogs).toEqual([]);

    // The store snapshot is picked up after hydration.
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe("mobile");

    // ...and the subscription is live: a media change re-renders.
    matches = false;
    await act(async () => {
      for (const cb of listeners) cb();
    });
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe("desktop");

    await act(async () => root!.unmount());
    container.remove();
  });

  it("reports desktop when the environment has no matchMedia at all", async () => {
    // @ts-expect-error deliberately removing the API to exercise the guard
    delete window.matchMedia;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("desktop");
    await act(async () => root.unmount());
    container.remove();
  });
});
