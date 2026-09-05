import { intFromEnv } from "@/lib/env";

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
 */
function trustedProxyCount(): number {
  // NaN-safe read shared with the pool config (P2-12); also declared in
  // serverEnvSchema for boot-time validation.
  return intFromEnv("TRUSTED_PROXY_COUNT", 1);
}

/** Returns the best-effort real client IP, or null when none can be trusted. */
export function getClientIp(headers: Headers): string | null {
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
  return ips[idx >= 0 ? idx : 0] ?? null;
}

/**
 * The request header that carries the trusted client IP to Better Auth.
 *
 * Better Auth's own resolver (`getIp` in `@better-auth/core/utils/ip`) trusts
 * a forwarded header only when it holds exactly ONE value, so behind a
 * multi-hop chain every request collapsed into its shared `no-trusted-ip`
 * bucket (3 sign-ins / 10 s for the whole deployment), and where the edge
 * sets no chain at all a client-supplied single value was trusted verbatim
 * (review #35). Instead, the proxy (`src/proxy.ts`) derives the IP with the
 * SAME `TRUSTED_PROXY_COUNT` model as {@link getClientIp} and writes it here
 * — always overwriting (or deleting) whatever the client sent — and Better
 * Auth is configured to read ONLY this header (`advanced.ipAddress.
 * ipAddressHeaders` in `src/lib/auth.ts`). One derivation, one trust model.
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
 * rather than each getting a fresh one).
 */
export function clientIpKey(headers: Headers): string {
  const ip = getClientIp(headers);
  return ip ? `ip:${ip}` : "anon";
}
