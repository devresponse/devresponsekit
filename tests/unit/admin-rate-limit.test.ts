import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitForTests,
  consumeToken,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/admin/rate-limit.server";

// `enforceRateLimit` lazy-imports `auditEvent` on the deny path; intercept it.
const auditSpy = vi.hoisted(() => vi.fn((_input: unknown) => Promise.resolve()));
vi.mock("@/lib/audit.server", () => ({ auditEvent: auditSpy }));

/**
 * Unit tests for the in-memory token-bucket rate limiter
 * (docs/admin-manager.md §19 Phase 7, §20.1 #16).
 *
 * Verifies the contract documented in `rate-limit.server.ts`:
 *   - Burst capacity: the first `capacity` requests within an instant
 *     all succeed.
 *   - Refill: tokens replenish at `refillPerSec` over wall-clock time.
 *   - Deny envelope: `enforceRateLimit` returns a 429 with a
 *     `Retry-After` header that matches the structured retry hint.
 *   - Per-key isolation: one noisy actor does not starve others.
 *
 * Time is injected via the `nowMs` parameter so the tests are
 * deterministic without faking the global Date.
 */
describe("admin rate limiter", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    auditSpy.mockClear();
  });

  it("allows up to capacity requests in a burst", () => {
    const opts = { capacity: 3, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    const denied = consumeToken("k", opts, 0);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills tokens proportionally to elapsed time", () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(false);
    // 1 full second later → 1 token refilled → next call passes.
    expect(consumeToken("k", opts, 1000).ok).toBe(true);
    // No further tokens available immediately after.
    expect(consumeToken("k", opts, 1000).ok).toBe(false);
  });

  it("caps refill at the bucket capacity", () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    // 1 hour later — even though `capacity * refillPerSec * 3600` >> 2,
    // the bucket should not exceed its capacity.
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(true);
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(true);
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(false);
  });

  it("isolates buckets by key", () => {
    const opts = { capacity: 1, refillPerSec: 1 };
    expect(consumeToken("a", opts, 0).ok).toBe(true);
    expect(consumeToken("a", opts, 0).ok).toBe(false);
    // A different key (different actor) is unaffected.
    expect(consumeToken("b", opts, 0).ok).toBe(true);
  });

  it("composes keys deterministically", () => {
    expect(rateLimitKey("scope", "actor")).toBe("scope:actor");
  });

  it("enforceRateLimit returns 429 with Retry-After on deny", async () => {
    const opts = { capacity: 1, refillPerSec: 1 };
    expect(enforceRateLimit("scope", "actor", opts, undefined, undefined, 0)).toBeNull();
    const denied = enforceRateLimit("scope", "actor", opts, undefined, undefined, 0);
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBeTruthy();
    const body = await denied!.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfter).toBe("number");
  });

  describe("denial audit (flood-safe, P3-9)", () => {
    it("audits a denial once per window — a 429 flood does NOT flood the audit log", async () => {
      const opts = { capacity: 1, refillPerSec: 1 };
      // First request consumes the token (allowed → no audit).
      expect(
        enforceRateLimit("admin.users.create", "ba-1", opts, undefined, undefined, 0),
      ).toBeNull();
      // A burst of 5 denials at the same instant.
      for (let i = 0; i < 5; i++) {
        enforceRateLimit("admin.users.create", "ba-1", opts, undefined, undefined, 0);
      }
      // Audited EXACTLY once (the DENIAL_AUDIT_LIMIT bucket gates the rest).
      await vi.waitFor(() => expect(auditSpy).toHaveBeenCalledTimes(1));
      expect(auditSpy.mock.calls[0]![0]).toMatchObject({
        eventType: "administrator.rate_limited",
        outcome: "denied",
        actorBetterAuthUserId: "ba-1",
        reason: "admin.users.create",
        metadata: expect.objectContaining({ scope: "admin.users.create", actor: "ba-1" }),
      });
    });

    it("audits again once the denial-audit window refills", async () => {
      // Main bucket refills far slower than the audit bucket, so the actor stays
      // denied across the window while the audit bucket replenishes its 1 token.
      const opts = { capacity: 1, refillPerSec: 0.001 };
      enforceRateLimit("scope", "ba-1", opts, undefined, undefined, 0); // allow
      enforceRateLimit("scope", "ba-1", opts, undefined, undefined, 0); // deny → audit #1
      enforceRateLimit("scope", "ba-1", opts, undefined, undefined, 0); // deny → suppressed
      await vi.waitFor(() => expect(auditSpy).toHaveBeenCalledTimes(1));
      // 60s later the audit bucket has refilled one token → next denial audits.
      enforceRateLimit("scope", "ba-1", opts, undefined, undefined, 60_000);
      await vi.waitFor(() => expect(auditSpy).toHaveBeenCalledTimes(2));
    });

    it("does not audit an allowed request", async () => {
      enforceRateLimit("scope", "ba-1", { capacity: 5, refillPerSec: 1 }, undefined, undefined, 0);
      await new Promise((r) => setTimeout(r, 10)); // let any stray async audit fire
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("records a null actor id for an IP-keyed (pre-auth) actor", async () => {
      const opts = { capacity: 1, refillPerSec: 1 };
      enforceRateLimit("scope", "ip:1.2.3.4", opts, undefined, undefined, 0); // allow
      enforceRateLimit("scope", "ip:1.2.3.4", opts, undefined, undefined, 0); // deny → audit
      await vi.waitFor(() => expect(auditSpy).toHaveBeenCalledTimes(1));
      expect(auditSpy.mock.calls[0]![0]).toMatchObject({
        actorBetterAuthUserId: null,
        metadata: expect.objectContaining({ actor: "ip:1.2.3.4" }),
      });
    });
  });
});
