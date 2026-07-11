import type { NextRequest } from "next/server";
import { serveSpaceAsset } from "@/lib/docs/asset-route.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/docs/asset/[...path]
 *
 * Streams an image referenced by a documentation-space document. The
 * auth, path-safety, and header hardening live in the shared
 * `serveSpaceAsset` handler (also used by `/api/help/asset`).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return serveSpaceAsset("docs", path);
}
