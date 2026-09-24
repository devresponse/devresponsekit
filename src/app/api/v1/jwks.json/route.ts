import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { getJwks } from "@/lib/api-auth/jwt.server";
import { problemResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jwks.json
 *
 * Publishes the public JSON Web Key Set used to verify API access tokens
 * (design §6.3). Public, unauthenticated, and cacheable — resource
 * servers and downstream services verify tokens WITHOUT holding any
 * signing secret. Returns an empty key set (200) when JWT issuance is
 * disabled so clients get a well-formed document rather than an error.
 *
 * (The canonical `/.well-known/jwks.json` location can be added later via
 * a rewrite; Next.js route folders cannot start with a dot.)
 */
export async function GET(request: NextRequest) {
  const env = getServerEnv();
  if (!env.API_JWT_ENABLED || !env.API_JWT_PRIVATE_KEY) {
    return NextResponse.json({ keys: [] }, { headers: { "Cache-Control": "public, max-age=300" } });
  }

  let jwks: Awaited<ReturnType<typeof getJwks>>;
  try {
    jwks = await getJwks();
  } catch (error) {
    // The only thing that fails here is loading the configured keys, a server
    // misconfiguration (F-22, review #50). Answer a logged, uncached
    // problem+json 500 rather than an unhandled throw; the cause goes to the
    // log, never to the client.
    return problemResponse("internal_error", 500, request, {
      cause: error,
      detail: "The token signing keys could not be loaded.",
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(jwks, {
    headers: { "Cache-Control": "public, max-age=300", "content-type": "application/json" },
  });
}
