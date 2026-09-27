/**
 * Reads a request body with a hard byte cap (F-78).
 *
 * The public endpoints (`/api/mcp`, `/api/mcp/register`, `/api/v1/auth/token`,
 * `/api/security/csp-report`, the `/api/sso/consume` POST) read their body
 * before the caller is authenticated, and `request.json()` / `.text()` /
 * `.formData()` buffer however much arrives. The `src/proxy.ts` matcher skips
 * them (it covers only Better Auth's catch-all under `/api`), so Next's proxy
 * body limit never applied, and only Vercel caps a body (at 4.5 MB). On a
 * self-hosted deployment one client streaming a few hundred MB of JSON held
 * all of it in memory, and a handful of those at once exhausted the process,
 * before any credential was looked at. The CSP sink compared the length with
 * its 64 KiB cap only AFTER `request.text()` had buffered the whole thing.
 *
 * Two layers, so a client that declares its size is refused without a byte of
 * the body being read, and one that does not (chunked) is cut off at the cap:
 *
 *   1. a declared `Content-Length` above the cap is refused up front;
 *   2. otherwise the stream is read chunk by chunk and abandoned (the reader
 *      is cancelled) as soon as the running total passes the cap, so at most
 *      `maxBytes` plus one chunk is ever held.
 *
 * The caller maps the refusal into its own envelope (JSON-RPC, RFC 7591,
 * problem+json, the CSP sink's silent 204), normally a `413`. It returns
 * rather than throws for that reason. The caller also keeps its rate limiter
 * in front of this read, so a throttled request is refused unread.
 */

/** Why a body was not returned. */
export type BoundedBodyRefusal = "too_large" | "unreadable";

export type BoundedBody =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: BoundedBodyRefusal };

export type BoundedText = { ok: true; text: string } | { ok: false; reason: BoundedBodyRefusal };

/**
 * The body's bytes, or `too_large` once it passes `maxBytes`, or `unreadable`
 * when the stream fails (a client that aborted mid-upload, a body already
 * consumed). A request with no body reads as zero bytes.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get("content-length")?.trim();
  // Only a well-formed length is trusted to refuse early; anything else falls
  // through to the streaming cap, which does not depend on the header at all.
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Stop pulling: the rest is never buffered. The cancel is not awaited,
        // so a slow sender cannot hold the refusal up.
        reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * {@link readBoundedBody}, decoded as UTF-8 the way `Request.text()` decodes
 * (a leading BOM dropped, a malformed sequence replaced, never thrown).
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedText> {
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) return body;
  return { ok: true, text: new TextDecoder().decode(body.bytes) };
}
