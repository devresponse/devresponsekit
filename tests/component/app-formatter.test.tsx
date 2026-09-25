// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { AccountSessionsPanel } from "@/app/[locale]/(secure)/app/account/security/_sessions-panel";
import { FormatPreferencesProvider, useAppFormatter } from "@/components/i18n/format-preferences";
import type { DateFormatOption } from "@/lib/account/preferences";
import { createAppFormatter } from "@/lib/format/app-format";
import { renderWithIntl } from "../helpers/render-with-intl";
import { TEST_MESSAGES } from "../helpers/test-data-factories";

/**
 * F-37: a timestamp renders the same on the server and in the browser, in
 * the viewer's saved zone and format.
 *
 * Before F-37 every client grid built `new Intl.DateTimeFormat(locale, …)`
 * with no zone, so its server render used the server's zone (UTC in
 * production) and its client render the browser's: the text disagreed, and
 * the saved time zone and date format were never read. The hydration cases
 * below re-create that split in one process by changing `TZ` between the
 * server render and the hydration, the way a UTC server and a Vancouver
 * browser differ.
 */

const listSessions = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    listSessions: () => listSessions(),
    getSession: () => getSession(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
  },
}));

const INSTANT = "2026-06-13T22:04:05.000Z";

function Stamp() {
  const format = useAppFormatter();
  return <time dateTime={INSTANT}>{format.dateTime(INSTANT)}</time>;
}

/** The pre-F-37 shape: a formatter that names no zone. */
function AdHocStamp() {
  const text = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(INSTANT),
  );
  return <time dateTime={INSTANT}>{text}</time>;
}

function providers(
  children: ReactElement,
  timeZone: string,
  dateFormat: DateFormatOption = "iso8601",
) {
  return (
    <NextIntlClientProvider locale="en" messages={TEST_MESSAGES} timeZone={timeZone}>
      <FormatPreferencesProvider dateFormat={dateFormat} numberLocale={null}>
        {children}
      </FormatPreferencesProvider>
    </NextIntlClientProvider>
  );
}

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * Server-renders `tree` with the host in `serverTz`, then hydrates the same
 * tree with the host in `browserTz`. Returns React's hydration complaints.
 */
async function serverThenBrowser(tree: ReactElement, serverTz: string, browserTz: string) {
  process.env.TZ = serverTz;
  const html = renderToString(tree);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  process.env.TZ = browserTz;
  const recoverable: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(async () => {
    hydrateRoot(container, tree, { onRecoverableError: (error) => recoverable.push(error) });
  });
  return { html, container, problems: [...recoverable, ...consoleError.mock.calls] };
}

describe("useAppFormatter (F-37)", () => {
  it("with no format provider it is the UI locale's own style, in next-intl's zone", () => {
    // renderWithIntl mounts next-intl with timeZone="UTC" and no format provider.
    renderWithIntl(<Stamp />);
    const expected = createAppFormatter("en", {
      timeZone: "UTC",
      dateFormat: "system",
      numberLocale: null,
    }).dateTime(INSTANT);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("server render and browser hydration agree even when the hosts' zones differ", async () => {
    const tree = providers(<Stamp />, "Asia/Kathmandu");
    const { container, problems } = await serverThenBrowser(tree, "UTC", "America/Vancouver");
    expect(problems).toEqual([]);
    // Kathmandu is UTC+5:45 — neither host's zone.
    expect(container.textContent).toBe("2026-06-14 03:49");
    // ...and it is exactly what a server component's getAppFormatter prints
    // for the same preferences (tests/unit/viewer-format-server.test.ts).
    expect(container.textContent).toBe(
      createAppFormatter("en", {
        timeZone: "Asia/Kathmandu",
        dateFormat: "iso8601",
        numberLocale: null,
      }).dateTime(INSTANT),
    );
  });

  it("control: the pre-F-37 ad-hoc formatter disagrees across the same two hosts", async () => {
    const { html, container, problems } = await serverThenBrowser(
      providers(<AdHocStamp />, "Asia/Kathmandu"),
      "UTC",
      "America/Vancouver",
    );
    // The server said 10:04 PM (UTC); the browser would say 3:04 PM.
    expect(html).toContain("10:04");
    expect(problems.length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("03:49");
  });
});

describe("a real consumer: the account sessions panel", () => {
  beforeEach(() => {
    listSessions.mockReset();
    getSession.mockReset();
    listSessions.mockResolvedValue({
      data: [{ token: "tok", ipAddress: "203.0.113.9", expiresAt: "2026-10-01T00:00:00.000Z" }],
    });
    getSession.mockResolvedValue({ data: { session: { token: "tok" } } });
  });

  it("shows the expiry in the saved zone and date format", async () => {
    render(providers(<AccountSessionsPanel />, "Asia/Kathmandu"));
    expect(await screen.findByText(/Expires 2026-10-01 05:45/)).toBeInTheDocument();
  });

  it("with no saved format it uses the UI locale's style, still in the configured zone", async () => {
    render(providers(<AccountSessionsPanel />, "America/Vancouver", "system"));
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Vancouver",
    }).format(new Date("2026-10-01T00:00:00.000Z"));
    expect(await screen.findByText(`Expires ${expected}`, { exact: false })).toBeInTheDocument();
  });
});
