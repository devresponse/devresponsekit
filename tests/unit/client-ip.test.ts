import { describe, it, expect, afterEach, vi } from "vitest";
import { isIP } from "node:net";
import fc from "fast-check";
import type { BetterAuthOptions } from "better-auth";
import { getIP } from "better-auth/api";
import {
  CLIENT_IP_HEADER,
  applyClientIpHeader,
  getClientIp,
  clientIpKey,
  normalizeClientIp,
  withTrustedClientIp,
} from "@/lib/client-ip";

const h = (map: Record<string, string>) => new Headers(map);

afterEach(() => {
  vi.unstubAllEnvs();
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
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
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
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const headers = h({ "x-forwarded-for": "1.1.1.1, 7.7.7.7, 2.2.2.2" });
    applyClientIpHeader(headers);
    expect(headers.get(CLIENT_IP_HEADER)).toBe(getClientIp(headers));
    expect(headers.get(CLIENT_IP_HEADER)).toBe("7.7.7.7");
  });
});

/**
 * Review #35 (follow-up): server-side `auth.api.*` callers on routes the proxy
 * never matched (`/api/sso/consume`, `/api/administrator/*`) hand Better Auth
 * a stamped COPY of their headers, so an injected header is neutralised there
 * too and a read-only `next/headers()` store is never mutated.
 */
describe("withTrustedClientIp", () => {
  it("returns a copy stamped from the trusted hop and leaves the input untouched", () => {
    const input = h({ [CLIENT_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "6.6.6.6, 9.9.9.9" });
    const out = withTrustedClientIp(input);
    expect(out).not.toBe(input);
    expect(out.get(CLIENT_IP_HEADER)).toBe("9.9.9.9");
    // The caller's object (possibly a read-only Next store) is not mutated.
    expect(input.get(CLIENT_IP_HEADER)).toBe("6.6.6.6");
  });

  it("carries every other header through unchanged (cookies, user-agent)", () => {
    const out = withTrustedClientIp(
      h({ cookie: "ba.session=x", "user-agent": "ua", "x-forwarded-for": "9.9.9.9" }),
    );
    expect(out.get("cookie")).toBe("ba.session=x");
    expect(out.get("user-agent")).toBe("ua");
    expect(out.get(CLIENT_IP_HEADER)).toBe("9.9.9.9");
  });

  it("removes an injected header when nothing trustworthy is present (fail closed)", () => {
    const out = withTrustedClientIp(h({ [CLIENT_IP_HEADER]: "6.6.6.6" }));
    expect(out.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("is idempotent over headers the proxy already stamped", () => {
    const once = withTrustedClientIp(h({ "x-forwarded-for": "spoof, 9.9.9.9" }));
    const twice = withTrustedClientIp(once);
    expect(twice.get(CLIENT_IP_HEADER)).toBe(once.get(CLIENT_IP_HEADER));
    expect(twice.get(CLIENT_IP_HEADER)).toBe("9.9.9.9");
  });

  it("agrees with getClientIp — the audit row's derivation — for the same input", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const input = h({
      [CLIENT_IP_HEADER]: "6.6.6.6",
      "x-forwarded-for": "6.6.6.6, 7.7.7.7, 2.2.2.2",
    });
    expect(withTrustedClientIp(input).get(CLIENT_IP_HEADER)).toBe(getClientIp(input));
    expect(getClientIp(input)).toBe("7.7.7.7");
  });
});

describe("clientIpKey", () => {
  it("prefixes a found IP and falls back to a single shared anon bucket", () => {
    expect(clientIpKey(h({ "x-forwarded-for": "9.9.9.9" }))).toBe("ip:9.9.9.9");
    expect(clientIpKey(h({}))).toBe("anon");
  });
});

/**
 * F-16: the trusted hop is normalized ONCE, in getClientIp, so every consumer
 * sees a valid canonical address or nothing. Raw, a load balancer's
 * `ip:port` or a client's garbage hop failed the inet INSERT of the audit row
 * (22P02, after the mutation had committed), minted a limiter bucket per
 * port, and dropped the client into Better Auth's shared `no-trusted-ip`
 * bucket.
 */
describe("getClientIp — normalization (F-16)", () => {
  const vectors: Array<[string, string, string | null]> = [
    ["IPv4 with the port a load balancer appended", "203.0.113.5:51234", "203.0.113.5"],
    ["bracketed IPv6 with a port", "[2001:db8::1]:443", "2001:db8::1"],
    ["bracketed IPv6 without a port", "[2001:DB8::1]", "2001:db8::1"],
    ["IPv6 in upper case, uncompressed", "2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["IPv4-mapped IPv6", "::ffff:203.0.113.5", "203.0.113.5"],
    ["IPv4-mapped IPv6, hex form", "::FFFF:cb00:7105", "203.0.113.5"],
    ["bracketed IPv4-mapped IPv6 with a port", "[::ffff:203.0.113.5]:80", "203.0.113.5"],
    // A bare IPv6 address cannot carry a port: this IS an address.
    ["bare IPv6 whose last group looks like a port", "2001:db8::1:80", "2001:db8::1:80"],
    ["garbage", "x", null],
    ["RFC 7239 obfuscated identifier", "unknown", null],
    ["out-of-range octet", "999.1.1.1", null],
    ["leading-zero octet", "01.2.3.4", null],
    ["out-of-range octet with a port", "999.1.1.1:80", null],
    ["empty port", "203.0.113.5:", null],
    ["non-numeric port", "203.0.113.5:http", null],
    ["six-digit port", "203.0.113.5:123456", null],
    ["IPv4 in brackets", "[203.0.113.5]:80", null],
    ["IPv6 zone id (inet rejects it)", "fe80::1%eth0", null],
    ["bracketed IPv6 zone id with a port", "[fe80::1%eth0]:80", null],
    ["hostname", "proxy.internal", null],
    ["space-separated pair", "203.0.113.5 198.51.100.7", null],
  ];

  for (const [name, hop, expected] of vectors) {
    it(`${name}: ${JSON.stringify(hop)} → ${String(expected)}`, () => {
      expect(getClientIp(h({ "x-forwarded-for": hop }))).toBe(expected);
      expect(normalizeClientIp(hop)).toBe(expected);
    });
  }

  it("normalizes the x-real-ip fallback the same way", () => {
    expect(getClientIp(h({ "x-real-ip": "203.0.113.5:8080" }))).toBe("203.0.113.5");
    expect(getClientIp(h({ "x-real-ip": "::ffff:203.0.113.5" }))).toBe("203.0.113.5");
    expect(getClientIp(h({ "x-real-ip": "garbage" }))).toBeNull();
  });

  it("an invalid trusted hop yields null, never another hop (the spoofable leftmost stays unreachable)", () => {
    expect(getClientIp(h({ "x-forwarded-for": "198.51.100.7, garbage" }))).toBeNull();
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    expect(getClientIp(h({ "x-forwarded-for": "198.51.100.7, 203.0.113.5:4711, 10.0.0.2" }))).toBe(
      "203.0.113.5",
    );
    expect(getClientIp(h({ "x-forwarded-for": "198.51.100.7, bogus, 10.0.0.2" }))).toBeNull();
  });

  it("stamps the normalized address into the header Better Auth reads, and removes it for garbage", () => {
    const ported = h({ "x-forwarded-for": "203.0.113.5:51234" });
    applyClientIpHeader(ported);
    expect(ported.get(CLIENT_IP_HEADER)).toBe("203.0.113.5");

    const garbage = h({ [CLIENT_IP_HEADER]: "198.51.100.7", "x-forwarded-for": "x" });
    applyClientIpHeader(garbage);
    expect(garbage.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("the stamped header keeps the FULL IPv6 address (Better Auth applies its own /64)", () => {
    const out = withTrustedClientIp(h({ "x-forwarded-for": "[2001:db8:1:2::abcd]:443" }));
    expect(out.get(CLIENT_IP_HEADER)).toBe("2001:db8:1:2::abcd");
  });

  // Properties over the whole input space, not just the examples above.
  const port = fc.integer({ min: 0, max: 65535 });

  it("PROPERTY: any value yields null or a canonical address isIP accepts, with no zone id", () => {
    const hopish = fc.oneof(
      fc.string(),
      fc.ipV4(),
      fc.ipV4Extended(),
      fc.ipV6(),
      fc.tuple(fc.ipV6(), port).map(([ip, p]) => `[${ip}]:${p}`),
      fc.tuple(fc.ipV4(), fc.string()).map(([ip, s]) => `${ip}:${s}`),
    );
    fc.assert(
      fc.property(hopish, (hop) => {
        const ip = normalizeClientIp(hop);
        if (ip === null) return;
        expect(isIP(ip)).not.toBe(0);
        // No zone id (isIP accepts one, inet does not), bracket or space. The
        // DB suite (tests/db/client-ip-inet.db.test.ts) asks Postgres itself.
        expect(ip).not.toMatch(/[%[\]\s]/);
        expect(ip).toBe(ip.toLowerCase());
        // Canonical: normalizing again changes nothing.
        expect(normalizeClientIp(ip)).toBe(ip);
      }),
      { numRuns: 2000 },
    );
  });

  it("PROPERTY: an IPv4 hop with any port resolves to the IPv4 and keys the same bucket", () => {
    fc.assert(
      fc.property(fc.ipV4(), port, (ip, p) => {
        expect(getClientIp(h({ "x-forwarded-for": `${ip}:${p}` }))).toBe(ip);
        expect(clientIpKey(h({ "x-forwarded-for": `${ip}:${p}` }))).toBe(`ip:${ip}`);
      }),
    );
  });

  it("PROPERTY: a bracketed IPv6 hop with any port resolves like the bare address", () => {
    fc.assert(
      fc.property(fc.ipV6(), port, (ip, p) => {
        const bare = getClientIp(h({ "x-forwarded-for": ip }));
        expect(bare).not.toBeNull();
        expect(getClientIp(h({ "x-forwarded-for": `[${ip}]:${p}` }))).toBe(bare);
      }),
    );
  });
});

/**
 * F-16: the app's per-IP limiter keys an IPv6 client by its /64, so a client
 * rotating its source address inside the prefix it was handed stays in one
 * bucket. Better Auth's limiter (and `session.ipAddress`) group by the same
 * /64, its default `ipv6Subnet`, so the two limiters agree on who one client is.
 */
describe("clientIpKey — IPv6 /64 grouping (F-16)", () => {
  const key = (hop: string) => clientIpKey(h({ "x-forwarded-for": hop }));

  it("keys an IPv6 client by its /64", () => {
    expect(key("2001:db8:1:2::a")).toBe("ip:2001:db8:1:2::/64");
    expect(key("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("ip:2001:db8:1:2::/64");
    expect(key("[2001:DB8:1:2::a]:443")).toBe("ip:2001:db8:1:2::/64");
    expect(key("2001:db8:1:3::a")).toBe("ip:2001:db8:1:3::/64");
    expect(key("2001:db8::1")).toBe("ip:2001:db8::/64");
    expect(key("::1")).toBe("ip:::/64");
    // Groups after the `::` can still fall inside the /64.
    expect(key("1::3:4:5:6:7")).toBe("ip:1:0:0:3::/64");
    // A dotted IPv4 tail sits outside the first 64 bits.
    expect(key("64:ff9b::203.0.113.5")).toBe("ip:64:ff9b::/64");
    expect(key("::203.0.113.5")).toBe("ip:::/64");
  });

  it("keys an IPv4-mapped client by its IPv4, like a plain IPv4 client", () => {
    expect(key("::ffff:203.0.113.5")).toBe("ip:203.0.113.5");
    expect(key("203.0.113.5")).toBe("ip:203.0.113.5");
  });

  it("falls back to the shared anon bucket for garbage instead of a bucket per value", () => {
    expect(key("x")).toBe("anon");
    expect(key("y")).toBe("anon");
  });

  /** The exact Better Auth option block `src/lib/auth.ts` passes. */
  const betterAuthIpOptions = {
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  } as BetterAuthOptions;
  /** What Better Auth's limiter and `session.ipAddress` key on for this hop. */
  const betterAuthIp = (hop: string) =>
    getIP(withTrustedClientIp(h({ "x-forwarded-for": hop })), betterAuthIpOptions);

  const group = fc.integer({ min: 0, max: 0xffff });
  const groups = (n: number) => fc.array(group, { minLength: n, maxLength: n });
  const v6 = (g: number[]) => g.map((x) => x.toString(16)).join(":");
  // `::ffff:0:0/96` is IPv4 in disguise and keyed as IPv4, not by prefix.
  const notMapped = (g: number[]) => !(g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff);

  it("PROPERTY: two addresses share a key exactly when they share Better Auth's /64", () => {
    fc.assert(
      fc.property(
        groups(8).filter(notMapped),
        groups(4),
        fc.integer({ min: 0, max: 63 }),
        (a, tail, bit) => {
          const sibling = [...a.slice(0, 4), ...tail];
          fc.pre(notMapped(sibling));
          const outside = [...a];
          outside[bit >> 4] = a[bit >> 4]! ^ (1 << (15 - (bit & 15)));
          fc.pre(notMapped(outside));

          // Same /64: one bucket in both limiters.
          expect(key(v6(sibling))).toBe(key(v6(a)));
          expect(betterAuthIp(v6(sibling))).toBe(betterAuthIp(v6(a)));
          // One bit different inside the /64 prefix: separate buckets in both.
          expect(key(v6(outside))).not.toBe(key(v6(a)));
          expect(betterAuthIp(v6(outside))).not.toBe(betterAuthIp(v6(a)));
        },
      ),
      { numRuns: 500 },
    );
  });
});
