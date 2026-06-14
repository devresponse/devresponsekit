import { describe, it, expect, afterEach } from "vitest";
import { getClientIp, clientIpKey } from "@/lib/client-ip";

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

describe("clientIpKey", () => {
  it("prefixes a found IP and falls back to a single shared anon bucket", () => {
    expect(clientIpKey(h({ "x-forwarded-for": "9.9.9.9" }))).toBe("ip:9.9.9.9");
    expect(clientIpKey(h({}))).toBe("anon");
  });
});
