/**
 * Where the trusted client IP comes from: the `CLIENT_IP_SOURCE` setting (F-17).
 *
 * The default model (`xff`) counts `TRUSTED_PROXY_COUNT` hops from the right of
 * `X-Forwarded-For`, which is only sound when the edge in front of the app
 * APPENDS to (or overwrites) that header. Two common topologies do not:
 *
 *   - no proxy at all (`docker run -p 3000:3000`): Next fills the header from
 *     the socket with `??=`, so a client that sends its own `X-Forwarded-For`
 *     keeps it, and every request can name a fresh address;
 *   - a proxy that only sets `X-Real-IP` (nginx
 *     `proxy_set_header X-Real-IP $remote_addr`) or a CDN that sets its own
 *     header (`CF-Connecting-IP`): the client's `X-Forwarded-For` passes
 *     through untouched and wins over the header the proxy did write.
 *
 * In both, a random `X-Forwarded-For` per request minted a fresh sign-in
 * limiter bucket (unlimited password guessing) and forged the audit IP. This
 * setting lets such a deployment name the ONE header its edge writes, and the
 * resolver then ignores `X-Forwarded-For` entirely.
 *
 * This module has no imports on purpose: `env.ts` validates the value with
 * {@link parseClientIpSource}, and `env.ts` is in the Edge instrumentation
 * graph (`tests/unit/edge-import-graph.test.ts`). It reads `process.env`
 * itself rather than through `env.ts` for the same reason `trustedProxyCount`
 * does not go through the schema: it runs in the proxy on every request, and a
 * value the schema would refuse must not throw there.
 */

/** How the app reads the client IP. `x-real-ip` is a {@link ClientIpSource} of kind `header`. */
export type ClientIpSource =
  { readonly kind: "xff" } | { readonly kind: "header"; readonly header: string };

export type ParsedClientIpSource =
  | { readonly ok: true; readonly source: ClientIpSource }
  | { readonly ok: false; readonly reason: string };

/** RFC 7230 §3.2.6 `token`, the grammar of a header field name (matched after lower-casing). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Header names that are valid tokens but can never be the source, and why.
 * Refusing them at boot beats a deployment where every request lands in one
 * shared bucket (or, for the app's own header, reads back its own output).
 * `x-drk-client-ip` is `CLIENT_IP_HEADER` spelled out, because this module
 * cannot import `client-ip.ts` (`node:net`); `tests/unit/client-ip.test.ts`
 * pins that the two agree.
 */
const REFUSED_HEADERS: ReadonlyMap<string, string> = new Map([
  [
    "x-forwarded-for",
    "use `xff`: X-Forwarded-For is a list a client can extend, so it is only read by counting TRUSTED_PROXY_COUNT hops from the right",
  ],
  [
    "x-drk-client-ip",
    "it is the header the app itself stamps FROM this setting for Better Auth; reading it back would trust whatever arrived",
  ],
  [
    "forwarded",
    "the RFC 7239 Forwarded header holds a structured, client-extendable list, never a bare address",
  ],
]);

/**
 * Parses a `CLIENT_IP_SOURCE` value. Unset or blank is the default, `xff`.
 * Otherwise it is trimmed and lower-cased, and must be `xff`, `x-real-ip`, or
 * one header name (`cf-connecting-ip`, `true-client-ip`, `fly-client-ip`, …)
 * that is not in {@link REFUSED_HEADERS}.
 */
export function parseClientIpSource(raw: string | undefined): ParsedClientIpSource {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "xff") return { ok: true, source: { kind: "xff" } };
  if (!HEADER_NAME.test(value)) {
    return {
      ok: false,
      reason: "must be `xff`, `x-real-ip`, or a single HTTP header name such as `cf-connecting-ip`",
    };
  }
  const refused = REFUSED_HEADERS.get(value);
  if (refused) return { ok: false, reason: `\`${value}\` cannot be the source: ${refused}` };
  return { ok: true, source: { kind: "header", header: value } };
}

/**
 * The configured source, read from `process.env` on every call (so a test's
 * `vi.stubEnv` applies), or `null` when the value is invalid. The schema in
 * `env.ts` refuses such a value at boot; here it counts as naming NO
 * trustworthy header, so the resolver fails closed (shared bucket) instead of
 * falling back to the `X-Forwarded-For` model the operator was opting out of.
 */
export function clientIpSource(): ClientIpSource | null {
  const parsed = parseClientIpSource(process.env.CLIENT_IP_SOURCE);
  return parsed.ok ? parsed.source : null;
}
