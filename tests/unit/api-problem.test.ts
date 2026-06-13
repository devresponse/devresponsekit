import { describe, expect, it } from "vitest";
import { problemResponse } from "@/lib/api-auth/problem";

/**
 * The RFC 7807 error envelope used by the /api/v1 surface.
 */
describe("problemResponse", () => {
  const req = { headers: new Headers() };

  it("emits an application/problem+json document with stable fields", async () => {
    const res = problemResponse("forbidden", 403, req, { detail: "nope" });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
    expect(body.status).toBe(403);
    expect(body.title).toBe("Insufficient scope or permission");
    expect(body.detail).toBe("nope");
    expect(typeof body.requestId).toBe("string");
    expect(String(body.type)).toContain("/problems/forbidden");
  });

  it("merges extra members and custom headers", async () => {
    const res = problemResponse("rate_limited", 429, req, {
      extra: { retryAfter: 5 },
      headers: { "Retry-After": "5" },
    });
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryAfter).toBe(5);
  });
});
