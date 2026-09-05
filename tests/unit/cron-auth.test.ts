import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "@/lib/cron-auth.server";

/**
 * The bearer check shared by every `/api/internal/*` scheduler route
 * (`outbox-drain`, `mcp-registration-reap`; review #51 / #92). Pins the
 * fail-closed contract in isolation from any one route's plumbing.
 */
const SECRET = "test-cron-secret-value-at-least-32-chars-long";

function req(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://localhost/api/internal/anything", { headers });
}

describe("isCronAuthorized", () => {
  it("accepts exactly the configured bearer", () => {
    expect(isCronAuthorized(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it("FAILS CLOSED when no secret is configured — even with a bearer header", () => {
    expect(isCronAuthorized(req(`Bearer ${SECRET}`), undefined)).toBe(false);
    expect(isCronAuthorized(req(`Bearer ${SECRET}`), "")).toBe(false);
  });

  it("rejects a missing header, a non-Bearer scheme, and a wrong / prefix-only value", () => {
    expect(isCronAuthorized(req(), SECRET)).toBe(false);
    expect(isCronAuthorized(req(`Basic ${SECRET}`), SECRET)).toBe(false);
    expect(isCronAuthorized(req("Bearer not-the-secret"), SECRET)).toBe(false);
    // Same length, one byte off — the constant-time compare must still say no.
    expect(isCronAuthorized(req(`Bearer ${SECRET.slice(0, -1)}X`), SECRET)).toBe(false);
    // A prefix of the secret (length mismatch) must not authorize.
    expect(isCronAuthorized(req(`Bearer ${SECRET.slice(0, 10)}`), SECRET)).toBe(false);
  });
});
