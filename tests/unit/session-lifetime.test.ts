import { describe, expect, it } from "vitest";
import {
  IMPERSONATION_SESSION_MAX_AGE_SECONDS,
  isImpersonationSessionPastMaxAge,
  isSessionPastAbsoluteLifetime,
} from "@/lib/session-lifetime";

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

/**
 * F-08 — the hard cap on an impersonation session. Better Auth's one-hour
 * `expiresAt` rolls forward once the `dont_remember` cookie is dropped, so the
 * bound is measured here from CREATION, and — unlike the opt-in operator cap
 * above — an unreadable age counts as over, never as unbounded.
 */
describe("isImpersonationSessionPastMaxAge", () => {
  const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
  const CAP_MS = IMPERSONATION_SESSION_MAX_AGE_SECONDS * 1000;

  it("is one hour", () => {
    expect(IMPERSONATION_SESSION_MAX_AGE_SECONDS).toBe(60 * 60);
  });

  it("keeps a borrowed session younger than the cap", () => {
    expect(isImpersonationSessionPastMaxAge({ createdAt: new Date(NOW - CAP_MS + 1) }, NOW)).toBe(
      false,
    );
  });

  it("refuses a borrowed session at and past the cap, whatever its expiresAt says", () => {
    expect(isImpersonationSessionPastMaxAge({ createdAt: new Date(NOW - CAP_MS) }, NOW)).toBe(true);
    expect(
      isImpersonationSessionPastMaxAge(
        { createdAt: new Date(NOW - 9 * CAP_MS).toISOString() },
        NOW,
      ),
    ).toBe(true);
  });

  it("FAILS CLOSED when the creation time is missing or unreadable", () => {
    expect(isImpersonationSessionPastMaxAge({}, NOW)).toBe(true);
    expect(isImpersonationSessionPastMaxAge({ createdAt: null }, NOW)).toBe(true);
    expect(isImpersonationSessionPastMaxAge({ createdAt: "not a date" }, NOW)).toBe(true);
    expect(isImpersonationSessionPastMaxAge(null, NOW)).toBe(true);
    expect(isImpersonationSessionPastMaxAge(undefined, NOW)).toBe(true);
  });
});
