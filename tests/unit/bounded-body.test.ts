import { describe, expect, it, vi } from "vitest";
import { readBoundedBody, readBoundedText } from "@/lib/bounded-body";
import { chunkedBody, meteredBody } from "../helpers/request-body";

/**
 * F-78: the byte-capped body reader the public endpoints use in place of
 * `request.json()` / `.text()` / `.formData()`, which buffered any size. A
 * declared oversize body is refused without being read; an undeclared one is
 * abandoned as soon as the running total passes the cap.
 */
const URL = "https://app.test/x";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe("readBoundedBody (F-78)", () => {
  it("returns the whole body when it is under or exactly at the cap", async () => {
    const under = await readBoundedBody(post("abc"), 4);
    expect(under).toEqual({ ok: true, bytes: new TextEncoder().encode("abc") });
    const exact = await readBoundedBody(post("abcd"), 4);
    expect(exact.ok && new TextDecoder().decode(exact.bytes)).toBe("abcd");
  });

  it("joins a body that arrives in many chunks", async () => {
    const text = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => `item-${i}`) });
    const body = await readBoundedText(post(chunkedBody(text, 7)), 64 * 1024);
    expect(body).toEqual({ ok: true, text });
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const request = post("x".repeat(100), { "content-length": "100" });
    expect(await readBoundedBody(request, 99)).toEqual({ ok: false, reason: "too_large" });
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading an undeclared body at the cap and cancels the rest", async () => {
    // 40 chunks of 1 KiB against a 4 KiB cap: the fifth chunk passes it.
    const metered = meteredBody(1024, 40);
    const request = post(metered.stream);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readBoundedBody(request, 4 * 1024)).toEqual({ ok: false, reason: "too_large" });
    expect(metered.pulled).toBe(5);
    expect(metered.cancelled).toBe(true);
  });

  it("refuses cleanly when cancelling the rest fails (no unhandled rejection)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        throw new Error("socket already gone");
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await readBoundedBody(post(stream), 1024)).toEqual({
        ok: false,
        reason: "too_large",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("still caps the stream when the declared length is small or malformed", async () => {
    for (const declared of ["10", "not-a-number", "-1", ""]) {
      const metered = meteredBody(1024, 40);
      const request = post(metered.stream, { "content-length": declared });
      expect(await readBoundedBody(request, 2048)).toEqual({ ok: false, reason: "too_large" });
      expect(metered.pulled).toBe(3);
    }
  });

  it("reads a request with no body as zero bytes", async () => {
    const request = new Request(URL, { method: "POST" });
    expect(await readBoundedBody(request, 16)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it("reports a stream that fails, or a body already consumed, as unreadable", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client aborted"));
      },
    });
    expect(await readBoundedBody(post(failing), 1024)).toEqual({
      ok: false,
      reason: "unreadable",
    });

    const consumed = post("abc");
    await consumed.text();
    expect(await readBoundedBody(consumed, 1024)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("readBoundedText (F-78)", () => {
  it("decodes UTF-8 the way Request.text() does", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("é✓"), 0xff]);
    const expected = await post(bytes).text();
    expect(await readBoundedText(post(bytes), 1024)).toEqual({ ok: true, text: expected });
    expect(expected).toBe("é✓�");
  });

  it("passes a refusal through", async () => {
    expect(await readBoundedText(post("abcdef"), 5)).toEqual({ ok: false, reason: "too_large" });
  });
});
