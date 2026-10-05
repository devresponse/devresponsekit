import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";

/**
 * §29.7.7 — navigation API responses must NEVER include tokens.
 *
 * This drives the two real route handlers and the real menu loaders in
 * `src/lib/navigation.server.ts`; only the session, the access context, the
 * audit writer and the database are stubbed. `loadApplicationsMenu` reads
 * `app_enterprise_applications` with `selectAll()` and maps chosen fields, so
 * the stubbed rows carry secret-shaped extra columns: a refactor that spreads
 * the row (or otherwise starts emitting a credential) fails here.
 */

const SECRET_VALUE = "s3cr3t-value-that-must-not-leak";
const appRows = [
  {
    id: "portal",
    label: "Portal",
    description: "Customer portal",
    subdomain: "portal",
    origin: "https://portal.example.com",
    status: "available",
    organization_id: null,
    sort_order: 1,
    // Not real columns — present to prove the mapper drops anything extra.
    client_secret: SECRET_VALUE,
    access_token: SECRET_VALUE,
    api_key: SECRET_VALUE,
  },
];

const fakeQuery = {
  selectAll: () => fakeQuery,
  where: () => fakeQuery,
  orderBy: () => fakeQuery,
  execute: async () => appRows,
};

const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/db/database", () => ({ db: { selectFrom: () => fakeQuery } }));
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));

function makeRequest(url: string): NextRequest {
  const u = new URL(url);
  return { nextUrl: u, url: u.toString(), headers: new Headers() } as unknown as NextRequest;
}

const FORBIDDEN_KEYS = [
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "sessionToken",
  "bearer",
  "secret",
  "apiKey",
  "api_key",
  "authorization",
];

/** Walks the whole JSON body: no key may name a credential, no value may carry one. */
function assertNoTokens(label: string, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoTokens(`${label}[${i}]`, v));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(
          lower.includes(forbidden.toLowerCase()),
          `${label} contained forbidden key "${key}"`,
        ).toBe(false);
      }
      assertNoTokens(`${label}.${key}`, child);
    }
    return;
  }
  if (typeof value === "string") {
    expect(value, `${label} carried a credential value`).not.toContain(SECRET_VALUE);
    expect(value, `${label} embedded a token parameter`).not.toMatch(
      /[?&](token|jwt|access_token|id_token)=/,
    );
  }
}

const SUPERADMIN_ACCESS = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  // Every menu entry visible, so the shell-menu check covers all of them.
  permissions: ["shell.view", "superuser", "admin.users.read", "admin.audit.read"],
};

beforeEach(() => {
  sessionGetter.mockReset().mockResolvedValue({ user: { id: "ba-1" } });
  accessGetter.mockReset().mockResolvedValue(SUPERADMIN_ACCESS);
});
afterEach(() => vi.resetModules());

describe("no tokens in navigation API responses", () => {
  it("GET /api/navigation/applications drops every non-presentational column", async () => {
    const { GET } = await import("@/app/api/navigation/applications/route");
    const res = await GET(makeRequest("http://localhost/api/navigation/applications?locale=en"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; ssoLaunchUrl: string }> };
    // Guard against a vacuous pass: the stubbed row must actually be returned.
    expect(body.items.map((i) => i.id)).toEqual(["portal"]);
    // ssoLaunchUrl points at /api/sso/launch, which signs server-side.
    expect(body.items[0]!.ssoLaunchUrl).toMatch(/^\/api\/sso\/launch\?/);
    assertNoTokens("applications", body);
  });

  it("GET /api/navigation/shell-menu carries only presentational metadata", async () => {
    const { GET } = await import("@/app/api/navigation/shell-menu/route");
    const res = await GET(
      makeRequest("http://localhost/api/navigation/shell-menu?scope=primary&locale=en"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    assertNoTokens("shell-menu", body);
  });
});
