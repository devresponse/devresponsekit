import type { NextRequest } from "next/server";
import { serveSpaceAsset } from "@/lib/docs/asset-route.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/help/asset/[...path]
 *
 * Streams an image referenced by a help-space document (the walkthrough
 * screenshots). Identical to `/api/docs/asset` — the auth, path-safety,
 * and header hardening live in the shared `serveSpaceAsset` handler.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return serveSpaceAsset("help", path);
}
