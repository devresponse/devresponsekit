import { readFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { resolveAssetFile } from "@/lib/docs/safe-path.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/docs/asset/[...path]
 *
 * Streams an image referenced by a document. Security:
 *   - Auth-gated: active session, active membership, and the baseline
 *     `shell.view` permission — same audience as the docs viewer. Returns
 *     404 (not 401/403) on any failure so the route never reveals whether
 *     a given file exists to an unauthorized caller.
 *   - Path-safe: `resolveAssetFile` confines the path to the docs root and
 *     restricts it to the image allow-list; anything else 404s.
 *   - Hardened headers: `nosniff` + a no-script CSP so a served SVG can
 *     never execute, and `private` caching since content is access-scoped.
 */
function notFound() {
  return new NextResponse(null, { status: 404 });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const session = await getCurrentSession();
  if (!session) return notFound();

  const access = await getUserAccessContext(session.user.id);
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") return notFound();
  if (!access.permissions.includes("shell.view")) return notFound();

  const { path } = await params;
  const resolved = await resolveAssetFile(path);
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
