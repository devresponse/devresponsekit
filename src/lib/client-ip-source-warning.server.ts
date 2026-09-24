import "server-only";
import { trustedProxyCount } from "@/lib/forwarded-hops";
import { logger } from "@/lib/observability/logger.server";

/** Where the operator reads how to choose a client-IP source. */
export const CLIENT_IP_SOURCE_DOCS = "docs/configuration.md#reverse-proxy--limits";

/**
 * Boot warning (F-17): a self-hosted production deployment that has not said
 * where the client IP comes from.
 *
 * The default `CLIENT_IP_SOURCE` (`xff`) is right on Vercel, whose edge
 * overwrites `X-Forwarded-For`, and behind any proxy that overwrites the
 * header or appends to it. It is wrong with no proxy at all, because Next only
 * fills the header when the client did not send one, and behind a proxy that
 * only sets `X-Real-IP` or a CDN header. There a client picks its own address:
 * a fresh sign-in limiter bucket per request, and a forged IP on every audit
 * row and session. Nothing in a request tells those topologies apart, so the
 * operator has to declare it. Setting `CLIENT_IP_SOURCE` to any valid value,
 * `xff` included, records that choice and silences this.
 *
 * A warning, not a boot failure: the default is correct for most proxied
 * deployments, and refusing to boot would take every existing self-hosted
 * deployment down on upgrade. Called once per process from the Node branch of
 * `register()` in `src/instrumentation.ts`, which skips `next build`. Returns
 * whether it warned, for tests.
 */
export function warnIfClientIpSourceUndeclared(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  // Vercel's edge overwrites X-Forwarded-For, so the default is correct there.
  if (process.env.VERCEL) return false;
  if (process.env.CLIENT_IP_SOURCE?.trim()) return false;
  logger.warn(
    {
      kind: "client-ip-source",
      clientIpSource: "xff",
      trustedProxyCount: trustedProxyCount(),
      docs: CLIENT_IP_SOURCE_DOCS,
    },
    "CLIENT_IP_SOURCE is unset: per-IP rate limits (Better Auth's sign-in limiter included) and audit/session IPs trust X-Forwarded-For. " +
      "That is safe only when the edge in front of the app overwrites the client's X-Forwarded-For or appends to it; " +
      "with no proxy, or one that only sets X-Real-IP, a client sends its own and gets a fresh bucket per request. " +
      "Set CLIENT_IP_SOURCE=xff once the edge does, or x-real-ip / a header such as cf-connecting-ip to read the header it sets",
  );
  return true;
}
