import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOCS_ASSET_LIMIT, __resetRateLimitForTests } from "@/lib/admin/rate-limit.server";
import { serveSpaceAsset } from "@/lib/docs/asset-route.server";

/**
 * I-06: the docs and help image route is rate-limited per session user, as
 * docs/design-docs-viewer.md always said it was. The budget is charged only
 * to a caller the auth gate admitted, and to the human behind an
 * impersonated session.
 */
const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: async () => state.session }));
vi.mock("@/lib/session-access.server", () => ({
  getSessionAccessContext: async () => ({
    status: "active",
    membershipStatus: "active",
    permissions: ["shell.view"],
  }),
}));
// The deny path lazy-imports `auditEvent` for its sampled denial audit.
const auditSpy = vi.hoisted(() => vi.fn((_input: unknown) => Promise.resolve()));
vi.mock("@/lib/audit.server", () => ({ auditEvent: auditSpy }));

const SCREENSHOT = ["screenshots", "01-landing.png"];
const signedIn = (userId: string, impersonatedBy?: string) => ({
  user: { id: userId },
  session: impersonatedBy ? { impersonatedBy } : {},
});
const get = (space: "docs" | "help" = "help") =>
  serveSpaceAsset(space, SCREENSHOT, { headers: new Headers() });

async function spendBudget(): Promise<void> {
  for (let i = 0; i < DEFAULT_DOCS_ASSET_LIMIT.capacity; i++) {
    expect((await get()).status).toBe(200);
  }
}

beforeEach(() => {
  // Freeze the clock so no token refills while the loop spends the burst.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  __resetRateLimitForTests();
  auditSpy.mockClear();
  state.session = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("serveSpaceAsset rate limit (I-06)", () => {
  it("serves a member's images up to the burst, then answers 429 with Retry-After", async () => {
    state.session = signedIn("user-a");
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    for (let i = 1; i < DEFAULT_DOCS_ASSET_LIMIT.capacity; i++) {
      expect((await get()).status).toBe(200);
    }

    const denied = await get();
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(denied.headers.get("x-request-id")).toBeTruthy();
    expect(await denied.json()).toMatchObject({ error: "rate_limited" });

    // Each space keeps its own bucket (scope `<space>.asset`): the docs
    // route still answers, here a 404 since the screenshot lives under help/.
    expect((await get("docs")).status).toBe(404);

    // It refills: half a second buys the next image.
    vi.setSystemTime(new Date("2026-09-26T12:00:00.500Z"));
    expect((await get()).status).toBe(200);
  });

  it("answers a caller the gate refuses with 404 and charges no budget", async () => {
    for (let i = 0; i <= DEFAULT_DOCS_ASSET_LIMIT.capacity; i++) {
      expect((await get()).status).toBe(404);
    }
    state.session = signedIn("user-a");
    await spendBudget();
    expect((await get()).status).toBe(429);
  });

  it("keeps one budget per user", async () => {
    state.session = signedIn("user-a");
    await spendBudget();
    expect((await get()).status).toBe(429);

    state.session = signedIn("user-b");
    expect((await get()).status).toBe(200);
  });

  it("charges an impersonated session to the human behind it (F-07)", async () => {
    state.session = signedIn("target-1", "admin-1");
    await spendBudget();

    // Another borrowed identity is not a fresh budget for the same admin...
    state.session = signedIn("target-2", "admin-1");
    expect((await get()).status).toBe(429);
    // ...and the targets' own budgets are untouched.
    state.session = signedIn("target-1");
    expect((await get()).status).toBe(200);
  });
});
