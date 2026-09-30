import "server-only";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { DEFAULT_DOCS_ASSET_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess } from "@/lib/auth-status";
import { noteSessionImpersonation } from "@/lib/impersonation-attribution.server";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { resolveAssetFile } from "@/lib/docs/safe-path.server";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * Shared GET handler behind `/api/docs/asset/[...path]` and
 * `/api/help/asset/[...path]`.
 *
 * Streams an image referenced by a document in the given space. Security:
 *   - Auth-gated: active session, active membership, and the baseline
 *     `shell.view` permission — same audience as the viewers. Returns
 *     404 (not 401/403) on any failure so the route never reveals whether
 *     a given file exists to an unauthorized caller.
 *   - Rate-limited per session user (I-06), after the auth gate and before
 *     any disk access, so only a caller who may read assets ever sees a 429
 *     (it says nothing about which files exist) and a miss costs budget too.
 *   - Path-safe: `resolveAssetFile` confines the path to the space's
 *     content root and restricts it to the image allow-list; anything
 *     else 404s.
 *   - Hardened headers: `nosniff` + a no-script CSP so a served SVG can
 *     never execute, and `private` caching since content is access-scoped.
 */
function notFound() {
  return new NextResponse(null, { status: 404 });
}

export async function serveSpaceAsset(
  space: DocSpace,
  path: string[],
  request: { headers: Headers },
): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) return notFound();
  // F-07: read directly, not through a guard, so record an impersonation here:
  // the limiter below then charges the human behind it, and so does the
  // sampled denial audit.
  noteSessionImpersonation(request, session);

  const access = await getSessionAccessContext(session);
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") return notFound();
  if (!access.permissions.includes("shell.view")) return notFound();

  const limited = enforceRateLimit(
    `${space}.asset`,
    session.user.id,
    DEFAULT_DOCS_ASSET_LIMIT,
    request,
  );
  if (limited) return limited;

  const resolved = await resolveAssetFile(path, space);
  if (!resolved) return notFound();

  let data: Buffer;
  try {
    data = await readFile(resolved.absPath);
  } catch {
    return notFound();
  }

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": resolved.contentType,
      "Content-Length": String(data.length),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      // Defense-in-depth for SVG: no script may run from a served asset.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
