import { intFromEnv } from "@/lib/env";

/**
 * The `X-Forwarded-For` hop count shared by the client-IP resolver
 * (`src/lib/client-ip.ts`) and the request-id normaliser (`src/lib/request-id.ts`).
 *
 * This module must stay free of Node built-ins. `request-id.ts` imports it, and
 * `instrumentation.ts` imports `request-id.ts` statically, so it is compiled
 * into the EDGE instrumentation bundle, where a Node built-in only gets a
 * warning and a stub that throws when used. `client-ip.ts` needs `node:net`
 * (F-16), so the dependency runs one way: `client-ip.ts` imports from here and
 * `request-id.ts` never imports `client-ip.ts`.
 * `tests/unit/edge-import-graph.test.ts` enforces both rules.
 */

/**
 * How many proxies in front of the app append to `X-Forwarded-For`
 * (`TRUSTED_PROXY_COUNT`, default 1: Vercel or a single load balancer).
 */
export function trustedProxyCount(): number {
  // NaN-safe read shared with the pool config (P2-12); also declared in
  // serverEnvSchema for boot-time validation.
  return intFromEnv("TRUSTED_PROXY_COUNT", 1);
}

/**
 * Whether the forwarded chain is at least `TRUSTED_PROXY_COUNT` entries long.
 *
 * READ THE NAME LITERALLY: this counts entries in `X-Forwarded-For`, a header
 * the CLIENT sends. It is **not** a provenance proof and must never be treated
 * as one (review #224):
 *
 *   - any direct caller satisfies it by adding one header
 *     (`x-forwarded-for: 1.2.3.4`), because nothing here distinguishes an
 *     entry a proxy appended from one the client typed;
 *   - behind a real edge (Vercel, any LB that sets the header) it is
 *     unconditionally TRUE, so it stops discriminating at all.
 *
 * It does not even rule out a direct request. Next.js fills a missing
 * `X-Forwarded-For` from the socket address (`??=` in its base server) before
 * any route handler or `onRequestError` reads the header, so every request the
 * app handles carries at least one entry. At the default `TRUSTED_PROXY_COUNT=1`
 * this is therefore true for all of them, local development included; at a
 * higher count it is false only for a chain shorter than the count, such as a
 * request that went around one of the proxies. An absent header reaches it only
 * where nothing filled it, e.g. a test calling a handler directly (F-17).
 *
 * The only caller is the request-id
 * normaliser ({@link import("@/lib/request-id").normalizeInboundRequestId}),
 * where the load-bearing check is the UUID format one and this is a weak
 * secondary bar over a value that is a correlation aid only. Nothing may make
 * a security decision on it, and no new caller should adopt it as one.
 *
 * (Contrast {@link import("@/lib/client-ip").getClientIp}, which uses
 * `TRUSTED_PROXY_COUNT` the sound way: it counts hops from the RIGHT to pick
 * the entry the app's own edge wrote, which a client cannot displace.)
 */
export function hasForwardedHops(xForwardedFor: string | null | undefined): boolean {
  const hops = (xForwardedFor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  return hops >= trustedProxyCount();
}
