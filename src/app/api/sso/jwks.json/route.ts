import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSsoHandoffJwks } from "@/lib/jwt-handoff.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/sso/jwks.json
 *
 * Publishes the public JSON Web Key Set used to verify SSO handoff tokens
 * (review #5). Public, unauthenticated, and cacheable — satellite consumers
 * verify handoffs against this document and hold NO signing secret, so a
 * compromised satellite can forge nothing for its siblings. Always mounted;
 * returns an empty key set (200) when this deployment issues no handoffs
 * (`SSO_HANDOFF_PRIVATE_KEY` unset) so consumers get a well-formed document
 * rather than an error. Mirrors `/api/v1/jwks.json`.
 */
export async function GET(_request: NextRequest) {
  const jwks = await getSsoHandoffJwks();
  return NextResponse.json(jwks, {
    headers: { "Cache-Control": "public, max-age=300", "content-type": "application/json" },
  });
}
