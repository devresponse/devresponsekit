import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json
 *
 * Serves the OpenAPI 3.1 description of the versioned REST surface
 * (design §8.1). Public + cacheable so codegen tools and API explorers
 * can discover the surface. The base URL is derived from the request
 * origin so the document is correct behind any host.
 */
export function GET(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  return NextResponse.json(buildOpenApiDocument(baseUrl), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
