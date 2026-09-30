// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.example/en/invite?token=InviteTok3nValue#access_token=FragTok3nValue", "referrer": "https://app.example/en/sign-in?email=referrer@example.com"}
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * R11, the browser half of the Sentry 11 port: the app's REAL browser config
 * (src/instrumentation-client.ts) on the REAL browser SDK, which streams spans
 * and sends no transaction events. Sentry 11 calls `beforeSendSpan` only when
 * its shape matches the trace lifecycle, and silently skips it otherwise, so
 * this proves the config's hook runs on every span the SDK sends and that
 * none of them ships a token. Nor does any envelope's header, whose trace
 * context names the root span and which no `before*` hook sees.
 *
 * The page is the invite link a user opens from an email, with a token in the
 * query and an implicit-flow token in the fragment, reached from a sign-in URL
 * that names an email. `@sentry/nextjs` is served by `@sentry/browser` with a
 * capturing transport, as in sentry-replay.test.ts, and the config's own
 * `beforeSendSpan` is wrapped only to record what the SDK handed it.
 */

const QUERY_TOKEN = "InviteTok3nValue";
const FRAGMENT_TOKEN = "FragTok3nValue";
const NAME_TOKEN = "CustomTok3nValue";
const SECRETS = [QUERY_TOKEN, FRAGMENT_TOKEN, NAME_TOKEN, "referrer@example.com"];

type SentSpan = { name: string; attributes: Record<string, { value: unknown } | undefined> };

const bodies = vi.hoisted(() => [] as (string | Uint8Array)[]);
const handed = vi.hoisted(() => [] as string[]);

vi.mock("@sentry/nextjs", async () => {
  const browser = await import("@sentry/browser");
  const { createTransport } = await import("@sentry/core");
  type InitOptions = NonNullable<Parameters<typeof browser.init>[0]>;
  return {
    ...browser,
    init: ({ beforeSendSpan, ...options }: InitOptions) =>
      browser.init({
        ...options,
        ...(beforeSendSpan && {
          beforeSendSpan: (span) => {
            handed.push(JSON.stringify(span));
            return beforeSendSpan(span);
          },
        }),
        transport: (transportOptions) =>
          createTransport(transportOptions, (request) => {
            bodies.push(request.body);
            return Promise.resolve({ statusCode: 200 });
          }),
      }),
    captureRouterTransitionStart: () => undefined,
  };
});

const processWithType = process as NodeJS.Process & { type?: string };
const originalProcessType = processWithType.type;

let spans: SentSpan[] = [];
/** Each envelope's header: its `trace` (the dynamic sampling context) names the root span. */
let envelopeHeaders: { trace?: { transaction?: string } }[] = [];

beforeAll(async () => {
  // `@sentry/core`'s isBrowser() is false under jsdom's Node `process`; the SDK
  // treats an Electron renderer as a browser (see sentry-replay.test.ts).
  processWithType.type = "renderer";
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@o1.ingest.sentry.io/1");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "1");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_REPLAYS_ERROR_SAMPLE_RATE", "0");
  expect(window.location.hash).toBe(`#access_token=${FRAGMENT_TOKEN}`);

  await import("@/instrumentation-client");
  const Sentry = await import("@sentry/nextjs");
  // A root span named from a URL, as an instrumentation without a route might
  // name one, with a child that carries its name on as `sentry.segment.name`.
  // It opens a trace of its own, so that trace's envelope header names it too.
  Sentry.startNewTrace(() =>
    Sentry.startSpan({ name: `GET /en/sso/confirm?token=${NAME_TOKEN}` }, () =>
      Sentry.startSpan({ name: "render" }, () => undefined),
    ),
  );
  // End the pageload span the tracing integration started.
  const active = Sentry.getActiveSpan();
  if (active) Sentry.getRootSpan(active).end();
  await Sentry.flush(2000);
  const { parseEnvelope } = await import("@sentry/core");
  const envelopes = bodies.map((body) => parseEnvelope(body));
  envelopeHeaders = envelopes.map(([header]) => header as (typeof envelopeHeaders)[number]);
  spans = envelopes
    .flatMap(([, items]) => items as [{ type: string }, unknown][])
    .filter(([header]) => header.type === "span")
    .flatMap(([, payload]) => (payload as { items: SentSpan[] }).items);
});

afterAll(async () => {
  const Sentry = await import("@sentry/nextjs");
  await Sentry.close(2000);
  processWithType.type = originalProcessType;
  vi.unstubAllEnvs();
});

const byName = (name: string) => spans.find((span) => span.name === name);

describe("browser spans through the real Sentry 11 SDK (R11)", () => {
  it("streams the pageload span and ours, each through the config's beforeSendSpan", () => {
    expect(spans.map((span) => span.name).sort()).toEqual([
      "GET /en/sso/confirm",
      "Pageload",
      "render",
    ]);
    expect(handed).toHaveLength(spans.length);
  });

  it("is needed: the SDK hands the hook the name's token and the page URL's fragment", () => {
    const raw = handed.join("\n");
    expect(raw).toContain(NAME_TOKEN);
    expect(raw).toContain(FRAGMENT_TOKEN);
  });

  it("ships no token, email or query string in any span or envelope header", () => {
    const json = JSON.stringify(spans);
    for (const secret of SECRETS) expect(json, `a span carries ${secret}`).not.toContain(secret);
    const headers = JSON.stringify(envelopeHeaders);
    for (const secret of SECRETS) {
      expect(headers, `an envelope header carries ${secret}`).not.toContain(secret);
    }
    expect(envelopeHeaders.map((header) => header.trace?.transaction)).toContain(
      "GET /en/sso/confirm",
    );
    expect(byName("Pageload")?.attributes["url.full"]?.value).toBe("https://app.example/en/invite");
    expect(byName("render")?.attributes["sentry.segment.name"]?.value).toBe("GET /en/sso/confirm");
  });
});
