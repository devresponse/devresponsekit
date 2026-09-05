import { describe, it, expect, afterEach } from "vitest";
import { CLIENT_IP_HEADER, applyClientIpHeader, getClientIp, clientIpKey } from "@/lib/client-ip";

const h = (map: Record<string, string>) => new Headers(map);

afterEach(() => {
  delete process.env.TRUSTED_PROXY_COUNT;
});

/**
 * P2-4: the client IP must come from a TRUSTED proxy hop, not the
 * spoofable leftmost X-Forwarded-For entry (which lets an attacker mint a
 * fresh rate-limit bucket per request).
 */
describe("getClientIp", () => {
  it("takes the rightmost XFF (the edge proxy's observation) by default", () => {
    expect(getClientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("ignores a spoofed leftmost entry — the real client is appended on the right", () => {
    // Attacker sends `X-Forwarded-For: evil`; the proxy appends the real IP.
    expect(getClientIp(h({ "x-forwarded-for": "evil, 9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("honors TRUSTED_PROXY_COUNT (2 proxies → second from the right)", () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    expect(getClientIp(h({ "x-forwarded-for": "1.1.1.1, 7.7.7.7, 2.2.2.2" }))).toBe("7.7.7.7");
  });

  it("falls back to x-real-ip when there is no forwarded chain", () => {
    expect(getClientIp(h({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5");
  });

  it("returns null when nothing trustworthy is present", () => {
    expect(getClientIp(h({}))).toBeNull();
  });
});

/**
 * Review #35: the header Better Auth reads is ALWAYS overwritten from the
 * trusted hop, so a client can neither pick another user's bucket nor keep a
 * value of its own when nothing trustworthy is present.
 */
describe("applyClientIpHeader", () => {
  it("sets the header from the trusted hop", () => {
    const headers = h({ "x-forwarded-for": "spoof, 9.9.9.9" });
    applyClientIpHeader(headers);
    expect(headers.get(CLIENT_IP_HEADER)).toBe("9.9.9.9");
  });

  it("overwrites a client-supplied value", () => {
    const headers = h({ [CLIENT_IP_HEADER]: "1.2.3.4", "x-forwarded-for": "1.2.3.4, 9.9.9.9" });
    applyClientIpHeader(headers);
    expect(headers.get(CLIENT_IP_HEADER)).toBe("9.9.9.9");
  });

  it("deletes a client-supplied value when no IP can be trusted", () => {
    const headers = h({ [CLIENT_IP_HEADER]: "1.2.3.4" });
    applyClientIpHeader(headers);
    expect(headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("honors TRUSTED_PROXY_COUNT like getClientIp", () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    const headers = h({ "x-forwarded-for": "1.1.1.1, 7.7.7.7, 2.2.2.2" });
    applyClientIpHeader(headers);
    expect(headers.get(CLIENT_IP_HEADER)).toBe(getClientIp(headers));
    expect(headers.get(CLIENT_IP_HEADER)).toBe("7.7.7.7");
  });
});

describe("clientIpKey", () => {
  it("prefixes a found IP and falls back to a single shared anon bucket", () => {
    expect(clientIpKey(h({ "x-forwarded-for": "9.9.9.9" }))).toBe("ip:9.9.9.9");
    expect(clientIpKey(h({}))).toBe("anon");
  });
});
