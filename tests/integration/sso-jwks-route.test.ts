import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import type { NextRequest } from "next/server";
import type * as JwksRouteModule from "@/app/api/sso/jwks.json/route";

/**
 * GET /api/sso/jwks.json (review #5): the public handoff key set consumers
 * verify against. Always mounted and public; `{ keys: [] }` when this
 * deployment issues no handoffs. Uses the real codec (no mocks) with an
 * ephemeral key so the "no `d`" guarantee is exercised end to end.
 */
function req(path: string): NextRequest {
  const u = new URL(`http://localhost${path}`);
  return { nextUrl: u, url: u.toString(), headers: new Headers() } as unknown as NextRequest;
}

const originalKey = process.env.SSO_HANDOFF_PRIVATE_KEY;
let GET: typeof JwksRouteModule.GET;

beforeEach(async () => {
  vi.resetModules();
  ({ GET } = await import("@/app/api/sso/jwks.json/route"));
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SSO_HANDOFF_PRIVATE_KEY;
  else process.env.SSO_HANDOFF_PRIVATE_KEY = originalKey;
});

describe("GET /api/sso/jwks.json", () => {
  it("returns an empty, cacheable key set when no handoff signing key is configured", async () => {
    delete process.env.SSO_HANDOFF_PRIVATE_KEY;
    vi.resetModules();
    ({ GET } = await import("@/app/api/sso/jwks.json/route"));
    const res = await GET(req("/api/sso/jwks.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [] });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("publishes the public half only (never `d`) when a key is configured", async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    process.env.SSO_HANDOFF_PRIVATE_KEY = JSON.stringify(await exportJWK(privateKey));
    vi.resetModules();
    ({ GET } = await import("@/app/api/sso/jwks.json/route"));
    const res = await GET(req("/api/sso/jwks.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(typeof body.keys[0]!.kid).toBe("string");
    expect(body.keys[0]).not.toHaveProperty("d");
  });
});
