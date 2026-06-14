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
  const raw = Number(process.env.TRUSTED_PROXY_COUNT);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
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
 * A rate-limit actor key derived from the client IP, or `"anon"` when no
 * trustworthy IP is available (so requests still share one bounded bucket
 * rather than each getting a fresh one).
 */
export function clientIpKey(headers: Headers): string {
  const ip = getClientIp(headers);
  return ip ? `ip:${ip}` : "anon";
}
