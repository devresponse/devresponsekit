// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.example/en/invite?token=InviteTok3nValue", "referrer": "https://app.example/en/sign-in?email=referrer@example.com"}
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * F-23 end to end: Session Replay must ship no token, email or query string
 * on any of its three channels (see the "Session Replay" section of
 * src/lib/observability/sentry-shared.ts).
 *
 * This drives the app's REAL browser config (src/instrumentation-client.ts)
 * through the REAL browser SDK, Session Replay integration and rrweb recorder
 * on a jsdom page. Only two things are swapped, both outside the scrubbing
 * path: `@sentry/nextjs` is served by `@sentry/browser` (the Next client build
 * is the same SDK, but Vitest resolves `@sentry/nextjs` to its server build),
 * with a transport that captures envelopes instead of posting them and
 * `minReplayDuration: 0` so a sub-second test session is not "too short" to
 * flush.
 *
 * The page is the invite link a user opens from an email, arriving from a
 * sign-in URL that carries an email. Before the fix the replay envelope
 * carried the invite token in `urls`, `request.url` and the rrweb Meta event,
 * the email in the `Referer` header, the token in each link's `href`, and the
 * handoff JWT in a hidden input's recorded value.
 */

const INVITE_TOKEN = "InviteTok3nValue";
const REFERRER_EMAIL = "referrer@example.com";
const HANDOFF_JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl";
const OPAQUE_HIDDEN = "OpaqueHiddenSecret99";
const MUTATION_TOKEN = "MutatedTok3nValue";
const ADDED_TOKEN = "AddedNodeTok3n";
const NAVIGATED_TOKEN = "NavigatedTok3nValue";
const SECRETS = [
  INVITE_TOKEN,
  REFERRER_EMAIL,
  HANDOFF_JWT,
  OPAQUE_HIDDEN,
  MUTATION_TOKEN,
  ADDED_TOKEN,
  NAVIGATED_TOKEN,
];

const bodies = vi.hoisted(() => [] as (string | Uint8Array)[]);

vi.mock("@sentry/nextjs", async () => {
  const browser = await import("@sentry/browser");
  const { createTransport } = await import("@sentry/core");
  type InitOptions = NonNullable<Parameters<typeof browser.init>[0]>;
  type ReplayOptions = NonNullable<Parameters<typeof browser.replayIntegration>[0]>;
  return {
    ...browser,
    init: (options: InitOptions) =>
      browser.init({
        ...options,
        transport: (transportOptions) =>
          createTransport(transportOptions, (request) => {
            bodies.push(request.body);
            return Promise.resolve({ statusCode: 200 });
          }),
      }),
    replayIntegration: (options: ReplayOptions) =>
      browser.replayIntegration({ ...options, minReplayDuration: 0 }),
    captureRouterTransitionStart: () => undefined,
  };
});

type EnvelopeItem = [{ type: string }, unknown];

async function envelopeItems(): Promise<EnvelopeItem[]> {
  const { parseEnvelope } = await import("@sentry/core");
  return bodies.flatMap((body) => parseEnvelope(body)[1] as EnvelopeItem[]);
}

/**
 * An item's text. A `replay_recording` payload is bytes, and under jsdom not
 * an `instanceof Uint8Array` of this realm, so this tests for a view: the
 * JSON of the bytes would hold only numbers and pass every "does not
 * contain" check below vacuously.
 */
function itemText(payload: unknown): string {
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
  }
  return JSON.stringify(payload);
}

/** The rrweb / SDK events of a `replay_recording` item (a segment header line, then a JSON array). */
function recordingEvents(payload: unknown): Record<string, unknown>[] {
  const text = itemText(payload);
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>[];
}

const flushTicks = () => new Promise((resolve) => setTimeout(resolve, 50));

const processWithType = process as NodeJS.Process & { type?: string };
const originalProcessType = processWithType.type;

let items: EnvelopeItem[] = [];

beforeAll(async () => {
  // `@sentry/core`'s isBrowser() is false whenever `process` is Node's, which
  // it is under jsdom, and Replay then never starts. The SDK treats an
  // Electron renderer (`process.type === "renderer"`) as a browser.
  processWithType.type = "renderer";
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@o1.ingest.sentry.io/1");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "0");
  // The page was reached from a sign-in URL that names an email (the pragma
  // above), so the HttpContext integration has a Referer to add.
  expect(document.referrer).toBe(`https://app.example/en/sign-in?email=${REFERRER_EMAIL}`);
  expect(window.location.search).toBe(`?token=${INVITE_TOKEN}`);

  document.body.innerHTML = `
    <main id="main">
      <p>Invitation for invitee@example.com</p>
      <a id="sign-up" href="/en/sign-up?invite=${INVITE_TOKEN}">Create account</a>
      <a id="sign-in" href="/en/sign-in?returnTo=%2Fen%2Finvite%3Ftoken%3D${INVITE_TOKEN}">Sign in</a>
      <a id="skip" href="#main">Skip</a>
      <form id="confirm" action="/en/sso/confirm?token=${INVITE_TOKEN}">
        <input type="hidden" name="token" value="${HANDOFF_JWT}">
        <input type="hidden" name="opaque" value="${OPAQUE_HIDDEN}">
      </form>
    </main>`;

  await import("@/instrumentation-client");
  const Sentry = await import("@sentry/nextjs");
  const replay = Sentry.getReplay();
  expect(replay).toBeDefined();
  await flushTicks();

  // A DOM mutation (an attribute change and an added node) and an App Router
  // style navigation, all inside the buffered minute.
  document.getElementById("sign-in")!.setAttribute("href", `/en/invite?token=${MUTATION_TOKEN}`);
  const added = document.createElement("a");
  added.setAttribute("href", `/en/reset-password?token=${ADDED_TOKEN}`);
  document.getElementById("main")!.append(added);
  window.history.pushState({}, "", `/en/sso/confirm?token=${NAVIGATED_TOKEN}`);
  await flushTicks();

  // A client error (a ChunkLoadError after a deploy, say) sends the error and
  // converts the buffered replay; `flush` is what the SDK's own post-error
  // timer calls, which jsdom does not run.
  Sentry.captureException(new Error("ChunkLoadError: Loading chunk 42 failed"));
  await flushTicks();
  await replay!.flush();
  await Sentry.flush(2000);
  items = await envelopeItems();
});

afterAll(async () => {
  const Sentry = await import("@sentry/nextjs");
  await Sentry.getReplay()?.stop({ flush: false });
  await Sentry.close(2000);
  processWithType.type = originalProcessType;
  vi.unstubAllEnvs();
});

describe("Session Replay through the real SDK (F-23)", () => {
  it("sends a replay: the error, a replay_event and its recording", () => {
    const types = items.map(([header]) => header.type);
    expect(types).toEqual(expect.arrayContaining(["event", "replay_event", "replay_recording"]));
  });

  it("ships no token, email or query string in any envelope item", () => {
    for (const [header, payload] of items) {
      const text = itemText(payload);
      for (const secret of SECRETS) {
        expect(text, `${header.type} carries ${secret}`).not.toContain(secret);
      }
      expect(text, `${header.type} carries a query`).not.toMatch(/[?&](?:token|invite|email)=/);
    }
  });

  it("scrubs the replay_event's urls, request.url and Referer (channel 1)", () => {
    const replayEvent = items.find(([header]) => header.type === "replay_event")?.[1] as {
      urls: string[];
      request: { url: string; headers: Record<string, string> };
    };
    expect(replayEvent.urls).toEqual([
      "https://app.example/en/invite",
      "https://app.example/en/sso/confirm",
    ]);
    expect(replayEvent.request.url).toBe("https://app.example/en/sso/confirm");
    expect(replayEvent.request.headers).not.toHaveProperty("Referer");
    expect(replayEvent.request.headers["User-Agent"]).toEqual(expect.any(String));
  });

  it("scrubs the SDK's own recording frames (channel 2)", () => {
    const push = recording()
      .map((event) => (event.data ?? {}) as { tag?: string; payload?: Record<string, unknown> })
      .find((data) => data.tag === "performanceSpan" && data.payload?.op === "navigation.push");
    expect(push?.payload?.description).toBe("https://app.example/en/sso/confirm");
  });

  it("scrubs rrweb's own events and keeps what the player needs (channel 3)", () => {
    const events = recording();
    // The page URL each snapshot opens with.
    const meta = events.find((event) => event.type === 4)?.data as { href: string };
    expect(meta.href).toBe("https://app.example/en/invite");

    // The full snapshot: links keep their path and lose their query (rrweb
    // made them absolute against the tokened page URL, `#main` included).
    const snapshot = events.find((event) => event.type === 2)?.data as { node: unknown };
    const byName = elementAttributes(snapshot.node);
    expect(byName.get("sign-up")?.href).toBe("https://app.example/en/sign-up");
    expect(byName.get("sign-in")?.href).toBe("https://app.example/en/sign-in");
    expect(byName.get("skip")?.href).toBe("https://app.example/en/invite");
    expect(byName.get("confirm")?.action).toBe("/en/sso/confirm");
    // Both hidden inputs are masked, the opaque one included (redactText
    // cannot recognise it; the `mask` selector does).
    expect(byName.get("token")?.value).toBe("*".repeat(HANDOFF_JWT.length));
    expect(byName.get("opaque")?.value).toBe("*".repeat(OPAQUE_HIDDEN.length));

    // The DOM mutations: the changed attribute and the added node.
    const mutations = events
      .filter((event) => event.type === 3)
      .map((event) => event.data as { source: number; adds?: unknown[]; attributes?: unknown[] })
      .filter((data) => data.source === 0);
    expect(JSON.stringify(mutations.flatMap((data) => data.attributes ?? []))).toContain(
      '"href":"https://app.example/en/invite"',
    );
    expect(JSON.stringify(mutations.flatMap((data) => data.adds ?? []))).toContain(
      '"href":"https://app.example/en/reset-password"',
    );
  });
});

/** Every recorded event across the replay's recording segments. */
function recording(): Record<string, unknown>[] {
  return items
    .filter(([header]) => header.type === "replay_recording")
    .flatMap(([, payload]) => recordingEvents(payload));
}

/** Recorded attributes of each element in a serialized rrweb tree, keyed by its `id` or `name`. */
function elementAttributes(root: unknown): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as { attributes?: Record<string, string>; childNodes?: unknown[] };
    const key = node.attributes?.id ?? node.attributes?.name;
    if (key) found.set(key, node.attributes!);
    pending.push(...(node.childNodes ?? []));
  }
  return found;
}
