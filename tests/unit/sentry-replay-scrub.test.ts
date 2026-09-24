import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
// The integration the app's browser config builds (`Sentry.replayIntegration`
// re-exports it); hoisted, see .npmrc.
import { replayIntegration } from "@sentry/replay";
import {
  type ReplayFrameEvent,
  installReplayRecordingScrubber,
  scrubReplayEvent,
  scrubReplayRecordingEvent,
  scrubRrwebEvent,
} from "@/lib/observability/sentry-shared";

/**
 * F-23: the Session Replay scrubbers, one channel at a time, on fixtures
 * shaped as @sentry/replay 10.75 builds them (the file and function each one
 * mirrors is named on it). tests/unit/sentry-replay.test.ts runs the same
 * scrubbers inside the real SDK and rrweb.
 */

const TOKEN = "Qx9InviteTokenValue";
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl";
const ORIGIN = "https://app.example";

function assertClean(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain(JWT);
  expect(json).not.toContain("alice@example.com");
  expect(json).not.toMatch(/[?#]/);
}

describe("scrubReplayEvent (channel 1: the replay_event item)", () => {
  /**
   * `sendReplayRequest`'s base event, after `prepareReplayEvent` ran the
   * HttpContext integration (`request` from `getHttpRequestData`: the page
   * URL plus the `Referer` and `User-Agent` headers) and applied the scope
   * (`contexts`, `transaction`).
   */
  function replayEvent(): Event {
    return {
      type: "replay_event",
      replay_start_timestamp: 1790000000,
      timestamp: 1790000060,
      error_ids: ["e1"],
      trace_ids: ["t1"],
      segment_names: [`${ORIGIN}/en/invite?token=${TOKEN}`],
      urls: [
        `${ORIGIN}/en/invite?token=${TOKEN}`,
        `${ORIGIN}/en/sso/confirm?token=${JWT}`,
        `${ORIGIN}/en/reset-password?token=${TOKEN}#top`,
      ],
      replay_id: "r1",
      segment_id: 0,
      replay_type: "buffer",
      request: {
        url: `${ORIGIN}/en/sso/confirm?token=${JWT}`,
        headers: {
          Referer: `${ORIGIN}/en/sign-in?email=alice@example.com`,
          "User-Agent": "ua",
        },
      },
      contexts: { trace: { trace_id: "t1", span_id: "s1" } },
      transaction: `/en/invite?token=${TOKEN}`,
    } as Event;
  }

  it("strips urls, request.url, the Referer header, segment names and the transaction", () => {
    const out = scrubReplayEvent(replayEvent()) as Event & Record<string, unknown>;
    assertClean(out);
    expect(out.urls).toEqual([
      `${ORIGIN}/en/invite`,
      `${ORIGIN}/en/sso/confirm`,
      `${ORIGIN}/en/reset-password`,
    ]);
    expect(out.segment_names).toEqual([`${ORIGIN}/en/invite`]);
    expect(out.request).toEqual({
      url: `${ORIGIN}/en/sso/confirm`,
      headers: { "User-Agent": "ua" },
    });
    expect(out.transaction).toBe("/en/invite");
    // Replay bookkeeping is untouched.
    expect(out).toMatchObject({ replay_id: "r1", error_ids: ["e1"], trace_ids: ["t1"] });
  });

  it("returns every other event kind untouched (the before* hooks own those)", () => {
    const url = `${ORIGIN}/en/invite?token=${TOKEN}`;
    for (const type of [undefined, "transaction", "feedback"] as const) {
      const event = { type, request: { url }, transaction: url } as Event;
      expect(scrubReplayEvent(event)).toEqual({ type, request: { url }, transaction: url });
    }
  });

  it("tolerates a replay event with no urls or request", () => {
    expect(scrubReplayEvent({ type: "replay_event" } as Event)).toEqual({ type: "replay_event" });
  });
});

/** A recording frame as `createPerformanceSpans` / `addBreadcrumbEvent` build it. */
function frame(tag: string, payload: Record<string, unknown>): ReplayFrameEvent {
  return {
    type: 5,
    timestamp: 1790000000000,
    data: { tag, payload },
  } as unknown as ReplayFrameEvent;
}
const payloadOf = (event: ReplayFrameEvent) =>
  event.data.payload as unknown as Record<string, unknown>;

describe("scrubReplayRecordingEvent (channel 2: the SDK's recording frames)", () => {
  const span = (op: string, description: string, data?: Record<string, unknown>) =>
    frame("performanceSpan", { op, description, startTimestamp: 1, endTimestamp: 2, data });

  it.each([
    // createNavigationEntry: `name` is the document URL.
    [
      "navigation.navigate",
      `${ORIGIN}/en/invite?token=${TOKEN}`,
      { size: 1, duration: 5, domComplete: 9 },
    ],
    ["navigation.reload", `${ORIGIN}/en/sso/confirm?token=${JWT}`, { size: 1 }],
    // handleHistory: `to` is the description, `from` the `previous`.
    [
      "navigation.push",
      `${ORIGIN}/en/sso/confirm?token=${JWT}`,
      { previous: `${ORIGIN}/en/invite?token=${TOKEN}` },
    ],
    // makeNetworkReplayBreadcrumb: an App Router RSC fetch and an XHR.
    [
      "resource.fetch",
      `/en/invite?token=${TOKEN}&_rsc=1a2b3`,
      { method: "GET", statusCode: 200, request: { size: 0, headers: {} } },
    ],
    [
      "resource.xhr",
      `${ORIGIN}/api/v1/me?email=alice@example.com`,
      { method: "GET", statusCode: 200 },
    ],
    // createResourceEntry: an asset request.
    ["resource.script", `${ORIGIN}/_next/static/chunks/app.js?token=${TOKEN}`, { size: 10 }],
    ["resource.link", `${ORIGIN}/en/invite?token=${TOKEN}`, { size: 10 }],
  ])("strips the URL a %s span names", (op, description, data) => {
    const out = scrubReplayRecordingEvent(span(op, description, data));
    assertClean(out);
    const payload = payloadOf(out);
    expect(payload.op).toBe(op);
    expect(payload.description).toBe(description.replace(/[?#].*$/, ""));
    // Non-URL data survives.
    for (const [key, value] of Object.entries(data)) {
      if (key !== "previous") expect((payload.data as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it("strips `previous` on a navigation.push", () => {
    const out = scrubReplayRecordingEvent(
      span("navigation.push", `${ORIGIN}/en/app`, {
        previous: `${ORIGIN}/en/invite?token=${TOKEN}`,
      }),
    );
    expect((payloadOf(out).data as Record<string, unknown>).previous).toBe(`${ORIGIN}/en/invite`);
  });

  it("leaves spans that name no URL alone (web vitals, memory)", () => {
    const vital = span("largest-contentful-paint", "largest-contentful-paint", {
      value: 1200,
      size: 1200,
      rating: "good",
      nodeIds: [3],
    });
    expect(scrubReplayRecordingEvent(structuredClone(vital))).toEqual(vital);
    const memory = span("memory", "memory", {
      memory: { jsHeapSizeLimit: 1, totalJSHeapSize: 2, usedJSHeapSize: 3 },
    });
    expect(scrubReplayRecordingEvent(structuredClone(memory))).toEqual(memory);
  });

  it.each([
    // ClickDetector#_generateBreadcrumbs: `url` is window.location.href.
    ["ui.slowClickDetected", { url: `${ORIGIN}/en/invite?token=${TOKEN}`, route: "/en/invite" }],
    ["ui.multiClick", { url: `${ORIGIN}/en/invite?token=${TOKEN}`, clickCount: 3 }],
    // handleHydrationError
    ["replay.hydrate-error", { url: `${ORIGIN}/en/sso/confirm?token=${JWT}` }],
    // a core navigation breadcrumb (already scrubbed by beforeBreadcrumb)
    ["navigation", { from: `/en/invite?token=${TOKEN}`, to: `/en/app?email=alice@example.com` }],
  ])("strips the URLs in a %s breadcrumb frame", (category, data) => {
    const out = scrubReplayRecordingEvent(
      frame("breadcrumb", { timestamp: 1, type: "default", category, message: "button.ok", data }),
    );
    assertClean(out);
    expect(payloadOf(out).category).toBe(category);
    expect(payloadOf(out).message).toBe("button.ok");
  });

  it("redacts a breadcrumb frame's message and keeps the options frame intact", () => {
    const consoleFrame = scrubReplayRecordingEvent(
      frame("breadcrumb", { category: "console", message: `sent to alice@example.com ${JWT}` }),
    );
    assertClean(consoleFrame);
    const options = frame("options", { maskAllText: true, errorSampleRate: 1 });
    expect(scrubReplayRecordingEvent(structuredClone(options))).toEqual(options);
  });
});

describe("scrubRrwebEvent (channel 3: rrweb's own events)", () => {
  it("strips the page URL a Meta event opens a snapshot with", () => {
    const meta = {
      type: 4,
      timestamp: 1,
      data: { href: `${ORIGIN}/en/invite?token=${TOKEN}`, width: 1, height: 2 },
    };
    expect(scrubRrwebEvent(meta).data).toEqual({
      href: `${ORIGIN}/en/invite`,
      width: 1,
      height: 2,
    });
  });

  /** A full snapshot as rrweb-snapshot serializes it (NodeType: 0 document, 2 element, 3 text). */
  function fullSnapshot() {
    return {
      type: 2,
      timestamp: 1,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "html",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: "style",
                  attributes: { _cssText: "a{color:red}" },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 4,
                  tagName: "a",
                  attributes: {
                    href: `${ORIGIN}/en/sign-in?returnTo=%2Fen%2Finvite%3Ftoken%3D${TOKEN}`,
                    class: "btn",
                    "data-email": "alice@example.com",
                    style: "color: red",
                  },
                  childNodes: [{ type: 3, id: 5, textContent: "****" }],
                },
                {
                  type: 2,
                  id: 6,
                  tagName: "input",
                  attributes: { type: "hidden", name: "token", value: JWT },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 7,
                  tagName: "img",
                  attributes: {
                    src: `${ORIGIN}/avatar.png?token=${TOKEN}`,
                    srcset: `${ORIGIN}/a.png?token=${TOKEN} 2x`,
                    rr_width: "10px",
                  },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 8,
                  tagName: "form",
                  attributes: { action: `/en/sso/confirm?token=${JWT}` },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 9,
                  tagName: "use",
                  attributes: { href: "#icon-check" },
                  childNodes: [],
                },
              ],
            },
          ],
        },
      },
    };
  }

  it("scrubs every element of a full snapshot and keeps what playback needs", () => {
    const out = scrubRrwebEvent(fullSnapshot());
    assertCleanExceptFragments(out);
    const html = out.data.node.childNodes[0]!;
    const [style, link, input, img, form, use] = html.childNodes;
    expect(style!.attributes).toEqual({ _cssText: "a{color:red}" });
    expect(link!.attributes).toEqual({
      href: `${ORIGIN}/en/sign-in`,
      class: "btn",
      "data-email": "[redacted-email]",
      style: "color: red",
    });
    expect(input!.attributes).toEqual({ type: "hidden", name: "token", value: "[redacted-token]" });
    expect(img!.attributes).toEqual({
      src: `${ORIGIN}/avatar.png`,
      srcset: `${ORIGIN}/a.png`,
      rr_width: "10px",
    });
    expect(form!.attributes).toEqual({ action: "/en/sso/confirm" });
    // A fragment-only reference is not a page URL (rrweb leaves `<use>` relative).
    expect(use!.attributes).toEqual({ href: "#icon-check" });
  });

  it("scrubs a mutation's added nodes and changed attributes", () => {
    const mutation = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [
          {
            parentId: 2,
            nextId: null,
            node: {
              type: 2,
              id: 10,
              tagName: "a",
              attributes: { href: `${ORIGIN}/en/reset-password?token=${TOKEN}` },
              childNodes: [],
            },
          },
        ],
        attributes: [
          {
            id: 4,
            attributes: { href: `${ORIGIN}/en/invite?token=${TOKEN}`, style: { color: "red" } },
          },
          { id: 6, attributes: { value: JWT, disabled: null } },
        ],
      },
    };
    const out = scrubRrwebEvent(mutation);
    assertClean(out);
    expect(out.data.adds[0]!.node.attributes).toEqual({ href: `${ORIGIN}/en/reset-password` });
    expect(out.data.attributes).toEqual([
      { id: 4, attributes: { href: `${ORIGIN}/en/invite`, style: { color: "red" } } },
      { id: 6, attributes: { value: "[redacted-token]", disabled: null } },
    ]);
  });

  it("passes other rrweb events through untouched", () => {
    const events = [
      { type: 0, timestamp: 1, data: {} },
      { type: 1, timestamp: 1, data: {} },
      // an input event (IncrementalSource.Input): masked by maskAllInputs
      { type: 3, timestamp: 1, data: { source: 5, id: 6, text: "****", isChecked: false } },
      { type: 3, timestamp: 1, data: { source: 3, id: 1, x: 0, y: 10 } },
    ];
    for (const event of events) expect(scrubRrwebEvent(structuredClone(event))).toEqual(event);
  });

  function assertCleanExceptFragments(value: unknown): void {
    const json = JSON.stringify(value);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(JWT);
    expect(json).not.toContain("alice@example.com");
    expect(json).not.toContain("?");
  }
});

describe("installReplayRecordingScrubber", () => {
  it("adds the rrweb plugin to the real integration's recording options", () => {
    const integration = replayIntegration({ maskAllText: true });
    expect(installReplayRecordingScrubber(integration)).toBe(true);
    const { plugins } = (integration as unknown as { _recordingOptions: { plugins: unknown[] } })
      ._recordingOptions;
    expect(plugins).toEqual([
      { name: "devresponsekit/url-scrub", eventProcessor: scrubRrwebEvent },
    ]);
  });

  it("appends to plugins already there", () => {
    const existing = { name: "other" };
    const integration = { _recordingOptions: { plugins: [existing] } };
    expect(installReplayRecordingScrubber(integration)).toBe(true);
    expect(integration._recordingOptions.plugins).toEqual([
      existing,
      { name: "devresponsekit/url-scrub", eventProcessor: scrubRrwebEvent },
    ]);
  });

  it("reports failure when the SDK no longer exposes the recording options", () => {
    expect(installReplayRecordingScrubber({ name: "Replay" })).toBe(false);
    expect(installReplayRecordingScrubber({ name: "Replay", _recordingOptions: null })).toBe(false);
  });
});
