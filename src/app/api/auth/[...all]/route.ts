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
 * header is (re)derived here with the app's `CLIENT_IP_SOURCE` /
 * `TRUSTED_PROXY_COUNT` model, overwriting or removing whatever arrived.
 * `src/proxy.ts` stamps the same header first, but this route does not rely
 * on the matcher covering it: Next injects `x-forwarded-for` from the socket
 * address only AFTER the proxy has run, and only when the client sent none.
 * That last part means a deployment with nothing in front of the app is NOT
 * safe (F-17): a client that sends its own `x-forwarded-for` keeps it, and
 * picks a fresh bucket per request. Only an edge that overwrites the header,
 * or `CLIENT_IP_SOURCE` naming a header such an edge sets, keeps per-client
 * buckets.
 *
 * Cache: never cache. Status codes are determined by Better Auth.
 */
const handler = toNextJsHandler(auth);

/**
 * The same request with the trusted client-IP header stamped.
 *
 * Rebuilt from its PARTS (url, method, headers, body) rather than via
 * `new Request(request, { headers })`: Next hands route handlers a
 * `NextRequest` built in its own realm, and on Node ≥ 24 undici's `Request`
 * constructor rejects a foreign `Request` as `input` ("Cannot read private
 * member #state"), which 500ed every auth call in production while the Node
 * 22 CI runtime accepted it. The body is buffered (auth payloads are small
 * JSON / form posts) so no cross-realm stream or `duplex` handling is
 * involved either; GET/HEAD carry none.
 */
async function withTrustedClientIpRequest(request: Request): Promise<Request> {
  const bodiless = request.method === "GET" || request.method === "HEAD";
  const body = bodiless || request.body === null ? null : await request.arrayBuffer();
  return new Request(request.url, {
    method: request.method,
    headers: withTrustedClientIp(request.headers),
    body,
  });
}

export const GET = async (request: Request) =>
  handler.GET(await withTrustedClientIpRequest(request));
export const POST = async (request: Request) =>
  handler.POST(await withTrustedClientIpRequest(request));
