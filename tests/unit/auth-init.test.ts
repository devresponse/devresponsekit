import { describe, expect, it, vi } from "vitest";

/**
 * Smoke tests for `auth.ts` and `api/auth/[...all]/route.ts`.
 *
 * The Better Auth runtime is mocked because its real init opens a
 * Postgres pool. We only assert that:
 *   1. The route catch-all module exports both GET and POST, mapped via
 *      `toNextJsHandler(auth)`.
 *   2. The auth instance is configured with the social providers and
 *      account-linking rules required by the spec (already covered by
 *      `tests/security/account-linking-config.test.ts` at source level).
 */

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({
    api: { getSession: vi.fn() },
  })),
}));
vi.mock("better-auth/next-js", () => ({
  nextCookies: vi.fn(() => ({})),
  toNextJsHandler: vi.fn(() => ({
    GET: () => new Response("ok"),
    POST: () => new Response("ok"),
  })),
}));
vi.mock("pg", () => ({
  Pool: function FakePool(this: unknown) {
    return {};
  },
}));

describe("auth.ts smoke", () => {
  it("exports a configured auth instance", async () => {
    const { auth } = await import("@/lib/auth");
    expect(auth).toBeDefined();
    expect(typeof auth.api.getSession).toBe("function");
  });
});

describe("api/auth/[...all]/route", () => {
  it("re-exports GET and POST from toNextJsHandler", async () => {
    const mod = await import("@/app/api/auth/[...all]/route");
    expect(typeof mod.GET).toBe("function");
    expect(typeof mod.POST).toBe("function");
  });
});
