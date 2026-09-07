import { describe, expect, it } from "vitest";
import { isSessionPastAbsoluteLifetime } from "@/lib/session-lifetime";

/**
 * The absolute-session-lifetime rule (review #200, ASVS V3 absolute timeout).
 *
 * The headline case is the DEFAULT: with the knob unset the answer is always
 * "keep the session", so enabling this work changed nothing for existing
 * deployments. Everything else pins the opt-in behaviour at its boundaries.
 */
describe("isSessionPastAbsoluteLifetime", () => {
  const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
  const HOUR = 60 * 60 * 1000;
  const oldSession = { createdAt: new Date(NOW - 1000 * HOUR) };

  it("never expires a session when the lifetime is unset (shipped default)", () => {
    expect(isSessionPastAbsoluteLifetime(oldSession, undefined, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(oldSession, null, NOW)).toBe(false);
  });

  it("ignores a non-positive or non-finite configured lifetime", () => {
    expect(isSessionPastAbsoluteLifetime(oldSession, 0, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(oldSession, -5, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(oldSession, Number.NaN, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(oldSession, Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });

  it("keeps a session younger than the configured lifetime", () => {
    expect(isSessionPastAbsoluteLifetime({ createdAt: new Date(NOW - 167 * HOUR) }, 168, NOW)).toBe(
      false,
    );
  });

  it("expires a session at and past the configured lifetime", () => {
    expect(isSessionPastAbsoluteLifetime({ createdAt: new Date(NOW - 168 * HOUR) }, 168, NOW)).toBe(
      true,
    );
    expect(isSessionPastAbsoluteLifetime({ createdAt: new Date(NOW - 200 * HOUR) }, 168, NOW)).toBe(
      true,
    );
  });

  it("accepts an ISO string or epoch-millisecond createdAt", () => {
    expect(
      isSessionPastAbsoluteLifetime(
        { createdAt: new Date(NOW - 200 * HOUR).toISOString() },
        168,
        NOW,
      ),
    ).toBe(true);
    expect(isSessionPastAbsoluteLifetime({ createdAt: NOW - 200 * HOUR }, 168, NOW)).toBe(true);
  });

  it("keeps a session whose createdAt is missing or unreadable", () => {
    // A cap must not kill sessions on a guess; the rolling expiry still applies.
    expect(isSessionPastAbsoluteLifetime({}, 168, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime({ createdAt: null }, 168, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime({ createdAt: "not a date" }, 168, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(null, 168, NOW)).toBe(false);
    expect(isSessionPastAbsoluteLifetime(undefined, 168, NOW)).toBe(false);
  });

  it("defaults `nowMs` to the wall clock", () => {
    expect(isSessionPastAbsoluteLifetime({ createdAt: new Date(Date.now() - 2 * HOUR) }, 1)).toBe(
      true,
    );
    expect(isSessionPastAbsoluteLifetime({ createdAt: new Date(Date.now() - 2 * HOUR) }, 24)).toBe(
      false,
    );
  });
});
