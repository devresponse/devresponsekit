import { auth } from "@/lib/auth";
import { withTrustedClientIp } from "@/lib/client-ip";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * GET/POST /api/auth/[...all]
 *
 * Better Auth catch-all route. Owns provider OAuth callbacks, email/password
 * sign-in, sign-up, sign-out, session refresh, and account linking. This
 * route MUST NOT be wrapped with custom auth checks — Better Auth manages
 * the full lifecycle internally and would deadlock otherwise.
 *
 * The ONE thing done before handing off is header normalization (review
 * #35): Better Auth reads the trusted client IP — for its sign-in / reset
 * limiter and `session.ipAddress` — from `x-drk-client-ip` only, and that
 * header is (re)derived here from the forwarded chain with the app's
 * `TRUSTED_PROXY_COUNT` model, overwriting or removing whatever arrived.
 * `src/proxy.ts` stamps the same header first, but this route does not rely
 * on the matcher covering it: Next also injects `x-forwarded-for` from the
 * socket address only AFTER the proxy has run, so re-deriving in the handler
 * is what keeps per-client buckets when nothing sits in front of the app.
 *
 * Cache: never cache. Status codes are determined by Better Auth.
 */
const handler = toNextJsHandler(auth);

/** The same request with the trusted client-IP header stamped; body untouched. */
function withTrustedClientIpRequest(request: Request): Request {
  return new Request(request, { headers: withTrustedClientIp(request.headers) });
}

export const GET = (request: Request) => handler.GET(withTrustedClientIpRequest(request));
export const POST = (request: Request) => handler.POST(withTrustedClientIpRequest(request));
