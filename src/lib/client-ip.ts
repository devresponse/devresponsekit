import { SocketAddress, isIP } from "node:net";
import { clientIpSource } from "@/lib/client-ip-source";
import { trustedProxyCount } from "@/lib/forwarded-hops";

/**
 * Trustworthy client-IP extraction for rate-limit keys (P2-4).
 *
 * `X-Forwarded-For` is appended LEFT→RIGHT by each proxy in the path, so
 * the **leftmost** entry is fully attacker-controlled (a client can send
 * `X-Forwarded-For: 1.2.3.4` and your edge proxy just appends the real IP
 * to the right). Taking the leftmost entry — as the old code did — lets an
 * attacker mint a fresh rate-limit bucket per request by rotating that
 * value, defeating the limiter.
 *
 * Instead we count `TRUSTED_PROXY_COUNT` hops from the RIGHT: the entry
 * your own trusted edge proxy/CDN recorded. With the default of one proxy
 * in front (Vercel / a single LB), that is the rightmost entry — the IP
 * the proxy actually observed connecting to it.
 *
 * That model needs an edge that appends to `X-Forwarded-For`. Where nothing
 * does (no proxy, or one that only sets `X-Real-IP` / `CF-Connecting-IP`),
 * the rightmost entry is whatever the client sent, so `CLIENT_IP_SOURCE`
 * (`src/lib/client-ip-source.ts`, F-17) names the one header that edge writes
 * instead and `X-Forwarded-For` is then ignored.
 *
 * This module imports `node:net` (F-16), so only Node code may import it.
 * Every importer today runs on Node, `proxy.ts` included (a Next 16 proxy
 * always uses the Node runtime). The EDGE instrumentation bundle must not
 * reach it: the hop counter `request-id.ts` needs lives in
 * `src/lib/forwarded-hops.ts` instead, and `tests/unit/edge-import-graph.test.ts`
 * fails if a Node built-in enters that graph.
 */

/**
 * An IPv4 hop carrying the source port a load balancer appended
 * (`203.0.113.5:51234`, the Azure App Service / Application Gateway shape).
 * `isIP` checks the octets afterwards, so this pattern only has to find the split.
 */
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
/** `[v6]` or `[v6]:port`: brackets are the only unambiguous way to put a port on an IPv6 hop. */
const BRACKETED = /^\[([^\]]*)\](?::\d{1,5})?$/;
/** An IPv4-mapped IPv6 address as {@link SocketAddress} prints it (`::ffff:192.0.2.1`). */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * Reduces one forwarded-header value to a canonical IP address, or `null` when
 * it is not one (F-16). Every consumer of the client IP stores or keys on the
 * result, and each of them needs a real address:
 *
 *   - `app_audit_events.ip_address` and `app_api_keys.last_used_ip` are `inet`.
 *     `203.0.113.5:51234` or `x` failed the INSERT with 22P02 — for an audit
 *     row, AFTER the mutation it records had committed, so the caller got a 500
 *     and the action went unaudited (a login row was lost silently);
 *   - the limiters key one bucket per distinct string, so a port suffix minted
 *     a fresh bucket per ephemeral port;
 *   - Better Auth validates what it reads from {@link CLIENT_IP_HEADER} and
 *     drops an invalid value, which put that client in its deployment-wide
 *     `no-trusted-ip` bucket with an empty `session.ipAddress`.
 *
 * So: trim; strip the port from `a.b.c.d:port` and `[v6]:port` (a bare IPv6
 * address cannot carry one: `2001:db8::1:80` IS an address); validate with
 * `isIP`; canonicalize IPv6 (lower case, zero-compressed) and map an
 * IPv4-mapped address (`::ffff:a.b.c.d`, hex form included) to its IPv4, as
 * Better Auth does. Anything else (garbage, `unknown`, a zone id) is `null`,
 * so the request is handled exactly like one with no trustworthy IP: shared
 * bucket, no header, `null` column. It is never passed through.
 */
export function normalizeClientIp(raw: string): string | null {
  const value = raw.trim();
  const bracketed = BRACKETED.exec(value)?.[1];
  if (bracketed !== undefined) return isIP(bracketed) === 6 ? canonicalIpv6(bracketed) : null;
  const address = IPV4_WITH_PORT.exec(value)?.[1] ?? value;
  switch (isIP(address)) {
    case 4:
      // `isIP` refuses leading zeros and out-of-range octets, so an IPv4
      // address that passes is already canonical.
      return address;
    case 6:
      return canonicalIpv6(address);
    default:
      return null;
  }
}

function canonicalIpv6(address: string): string | null {
  // `isIP` accepts a zone id (`fe80::1%eth0`), but it names an interface on the
  // proxy's host rather than a client, and `inet` rejects it.
  if (address.includes("%")) return null;
  try {
    const canonical = new SocketAddress({ address, family: "ipv6" }).address;
    return IPV4_MAPPED.exec(canonical)?.[1] ?? canonical;
  } catch {
    // Not expected for an address `isIP` accepted. Fail closed rather than
    // throw from the proxy on every request.
    return null;
  }
}

/**
 * The limiter subject for a normalized client IP (F-16): an IPv4 address as
 * is, an IPv6 address as its /64 (`2001:db8:1:2::/64`). One IPv6 subscriber is
 * routinely handed a whole /64 and can source each request from a fresh
 * address in it, so a per-address bucket never fills. /64 is also Better
 * Auth's default `ipv6Subnet`, so both limiters group the same clients. Only
 * the limiter keys use it: the audit row, the API-key stamp and the header
 * Better Auth reads keep the full address.
 */
function rateLimitSubject(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  // `ip` is canonical (canonicalIpv6): at most one `::`, and a dotted IPv4
  // only as the last 32 bits. Those never reach the first four groups, so a
  // dotted tail only has to count as its two groups.
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const prefix = `${groups.slice(0, 4).join(":")}::`;
  return `${new SocketAddress({ address: prefix, family: "ipv6" }).address}/64`;
}

/**
 * Returns the real client IP, normalized by {@link normalizeClientIp} (F-16),
 * or null when none can be trusted — including when the trusted hop holds
 * something that is not an IP address. A non-null result is always a valid,
 * canonical IPv4 or IPv6 address that an `inet` column accepts.
 */
export function getClientIp(headers: Headers): string | null {
  const hop = trustedHop(headers);
  return hop === null ? null : normalizeClientIp(hop);
}

/**
 * The raw value the configured source selects, before F-16 normalization:
 * the one header `CLIENT_IP_SOURCE` names, or the hop `TRUSTED_PROXY_COUNT`
 * selects (P2-4) under the default `xff`. Every consumer (audit rows, the
 * API-key stamp, the header Better Auth reads, the limiter keys, the MCP
 * forward) goes through here, so the source is chosen in exactly one place.
 */
function trustedHop(headers: Headers): string | null {
  const source = clientIpSource();
  // F-17: an invalid CLIENT_IP_SOURCE fails boot validation (env.ts). If it
  // is read anyway, it names no header we can trust: fail closed rather than
  // fall back to the X-Forwarded-For model the operator was opting out of.
  if (source === null) return null;
  // A named header is read alone. X-Forwarded-For is ignored even when it is
  // present, because on these topologies the client's copy passes through the
  // edge untouched. A repeated header arrives joined with ", ", which
  // normalization rejects rather than picking one of the values.
  if (source.kind === "header") return headers.get(source.header);

  const xff = headers.get("x-forwarded-for");
  const ips = xff
    ? xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (ips.length === 0) {
    // No forwarded chain — fall back to a platform-set real-ip header,
    // which a client cannot forge through a correctly-configured proxy.
    const real = headers.get("x-real-ip")?.trim();
    return real && real.length > 0 ? real : null;
  }

  // The entry the (TRUSTED_PROXY_COUNT)-th proxy from the edge recorded.
  const idx = ips.length - trustedProxyCount();
  // A chain SHORTER than the count takes its leftmost entry, and that is
  // deliberate (F-17). A client can only lengthen the chain, so a short one
  // means fewer proxies appended than configured (a count set too high, or a
  // request that skipped the CDN), and its leftmost entry is usually the
  // address the first real proxy saw. Failing closed to null would not stop an
  // attacker, who pads the chain to exactly the count, but it would put every
  // honest client in the one shared bucket: a sign-in lockout for everyone.
  return ips[idx >= 0 ? idx : 0] ?? null;
}

/**
 * The request header a server-to-server self-call uses to hand
 * {@link getClientIp} an address it already resolved (the MCP gateway's
 * `/api/v1` dispatch, audit #14): the header `CLIENT_IP_SOURCE` names, or
 * `x-forwarded-for` under the default `xff`. Sending `x-forwarded-for` under a
 * header source would be ignored by the receiving route, and every agent call
 * would land in the shared bucket with no audit IP (F-17).
 */
export function clientIpForwardHeader(): string {
  const source = clientIpSource();
  return source?.kind === "header" ? source.header : "x-forwarded-for";
}

/**
 * The request header that carries the trusted client IP to Better Auth.
 *
 * Better Auth's own resolver (`getIP` in `@better-auth/core/utils/ip`) trusts
 * a forwarded header only when it holds exactly ONE value, so behind a
 * multi-hop chain every request collapsed into its shared `no-trusted-ip`
 * bucket (3 sign-ins / 10 s for the whole deployment), and where the edge
 * sets no chain at all a client-supplied single value was trusted verbatim
 * (review #35). Instead, the proxy (`src/proxy.ts`) derives the IP with the
 * SAME `CLIENT_IP_SOURCE` / `TRUSTED_PROXY_COUNT` model as {@link getClientIp}
 * and writes it here — always overwriting (or deleting) whatever the client
 * sent — and Better Auth is configured to read ONLY this header
 * (`advanced.ipAddress.ipAddressHeaders` in `src/lib/auth.ts`). One
 * derivation, one trust model.
 *
 * The proxy is NOT the only line: its matcher covers page renders and
 * `/api/auth/*`, but server-side `auth.api.*` calls happen on other routes
 * too (`/api/sso/consume` establishes a session, the admin console
 * impersonates, …) and a client holding its own request could inject the
 * header there. Every such caller therefore passes its headers through
 * {@link withTrustedClientIp} first, and the catch-all route re-stamps the
 * header itself — so correctness never depends on the matcher covering a
 * given path, and the proxy is defence in depth.
 */
export const CLIENT_IP_HEADER = "x-drk-client-ip";

/**
 * Stamps {@link CLIENT_IP_HEADER} onto `headers` from the trusted hop of the
 * forwarded chain. The header is UNCONDITIONALLY overwritten: a value the
 * client injected is replaced when a trustworthy IP exists and removed when
 * none does, so it can never reach Better Auth unless this app set it.
 * Absent ⇒ Better Auth keys the request to its shared bucket, mirroring
 * {@link clientIpKey}'s `"anon"` — fail closed, never fail open.
 *
 * The value is the NORMALIZED full address (F-16): a port-suffixed hop now
 * reaches Better Auth as a valid IP instead of being dropped into
 * `no-trusted-ip`. It is not the /64: Better Auth masks an IPv6 address to its
 * `ipv6Subnet` (default 64) itself, for its limiter and `session.ipAddress`.
 */
export function applyClientIpHeader(headers: Headers): void {
  const ip = getClientIp(headers);
  if (ip) {
    headers.set(CLIENT_IP_HEADER, ip);
  } else {
    headers.delete(CLIENT_IP_HEADER);
  }
}

/**
 * The headers to hand a server-side `auth.api.*` call: a COPY of `headers`
 * with {@link CLIENT_IP_HEADER} derived from the trusted hop exactly as
 * {@link applyClientIpHeader} does (overwritten or removed, never passed
 * through). Use this at EVERY call site that forwards request headers to
 * Better Auth — session creation (`createSsoSession`, `impersonateUser`),
 * session reads, account updates — whether or not the proxy matched the
 * route: the input may be a client-controlled `request.headers` on a path the
 * proxy never saw, or a read-only `next/headers()` store, so the original is
 * never mutated.
 *
 * Idempotent: re-stamping headers the proxy already stamped yields the same
 * value, because both derive from the same forwarded chain.
 */
export function withTrustedClientIp(headers: Headers): Headers {
  const copy = new Headers(headers);
  applyClientIpHeader(copy);
  return copy;
}

/**
 * A rate-limit actor key derived from the client IP, or `"anon"` when no
 * trustworthy IP is available (so requests still share one bounded bucket
 * rather than each getting a fresh one). An IPv6 client is keyed by its /64
 * (F-16, {@link rateLimitSubject}), so rotating addresses inside the prefix
 * does not mint new buckets. Every per-IP limiter goes through here: the token
 * endpoint, MCP registration, the CSP sink and, through `actorIdFromRequest`,
 * the SSO launch/consume throttles.
 */
export function clientIpKey(headers: Headers): string {
  const ip = getClientIp(headers);
  return ip ? `ip:${rateLimitSubject(ip)}` : "anon";
}
