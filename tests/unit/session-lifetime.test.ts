import { describe, expect, it } from "vitest";
import {
  DEFAULT_SSO_SESSION_LIFETIME_HOURS,
  IMPERSONATION_SESSION_MAX_AGE_SECONDS,
  SSO_SESSION_TOKEN_PREFIX,
  isImpersonationSessionPastMaxAge,
  isSessionPastAbsoluteLifetime,
  isSessionPastLifetime,
  isSsoHandoffSession,
  isSsoSessionPastLifetime,
  ssoSessionTokenPrefix,
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

/**
 * F-82 — a session an SSO handoff opened carries its application in its
 * token and ends a fixed time after the handoff. Unlike the operator cap it is
 * never "off": no setting, or a nonsensical one, means the eight-hour default,
 * and an unreadable age counts as over.
 */
describe("handoff sessions (F-82)", () => {
  const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
  const HOUR = 60 * 60 * 1000;
  const aged = (hours: number) => ({ createdAt: new Date(NOW - hours * HOUR) });

  it("defaults the lifetime to eight hours", () => {
    expect(DEFAULT_SSO_SESSION_LIFETIME_HOURS).toBe(8);
  });

  it("prefixes an application's tokens with its id in hex, closed by a dot", () => {
    expect(ssoSessionTokenPrefix("portal")).toBe("sso.706f7274616c.");
    expect(ssoSessionTokenPrefix("acme.crm")).toBe("sso.61636d652e63726d.");
    // `_` would be a LIKE wildcard, and `.` a separator; hex has neither.
    expect(ssoSessionTokenPrefix("a_b")).toBe("sso.615f62.");
  });

  it("gives no application a prefix of another's", () => {
    // Written plainly, `sso.acme.` would also start every `acme.crm` token.
    const ids = ["acme", "acme.crm", "acme-crm", "a_b", "a-b", "ab"];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(ssoSessionTokenPrefix(b).startsWith(ssoSessionTokenPrefix(a)), `${a} / ${b}`).toBe(
          false,
        );
      }
    }
  });

  it("recognises a handoff token, and never one of Better Auth's own", () => {
    expect(isSsoHandoffSession({ token: `${ssoSessionTokenPrefix("portal")}abc` })).toBe(true);
    expect(SSO_SESSION_TOKEN_PREFIX).toBe("sso.");
    // Better Auth mints 32 letters and digits: no dot, so never the prefix.
    expect(isSsoHandoffSession({ token: `sso${"x".repeat(29)}` })).toBe(false);
    expect(isSsoHandoffSession({ token: undefined })).toBe(false);
    expect(isSsoHandoffSession({})).toBe(false);
    expect(isSsoHandoffSession(null)).toBe(false);
  });

  it("keeps a handoff session younger than the lifetime and ends it at and past it", () => {
    expect(isSsoSessionPastLifetime(aged(7.9), 8, NOW)).toBe(false);
    expect(isSsoSessionPastLifetime(aged(8), 8, NOW)).toBe(true);
    expect(isSsoSessionPastLifetime(aged(30), 8, NOW)).toBe(true);
    expect(isSsoSessionPastLifetime(aged(30), 48, NOW)).toBe(false);
  });

  it("treats no lifetime, or a nonsensical one, as the default rather than no cap", () => {
    for (const hours of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSsoSessionPastLifetime(aged(9), hours, NOW), String(hours)).toBe(true);
      expect(isSsoSessionPastLifetime(aged(7), hours, NOW), String(hours)).toBe(false);
    }
  });

  it("FAILS CLOSED when the creation time is missing or unreadable", () => {
    expect(isSsoSessionPastLifetime({}, 8, NOW)).toBe(true);
    expect(isSsoSessionPastLifetime({ createdAt: null }, 8, NOW)).toBe(true);
    expect(isSsoSessionPastLifetime({ createdAt: "not a date" }, 8, NOW)).toBe(true);
    expect(isSsoSessionPastLifetime(undefined, 8, NOW)).toBe(true);
  });
});

/**
 * F-54 — the combined rule both enforcement points share: `getCurrentSession`
 * and Better Auth's `hooks.before`. The operator cap applies to every session,
 * the one-hour cap only to a session carrying the impersonation marker, and
 * (F-82) the handoff lifetime only to a session whose token carries the
 * handoff prefix.
 */
describe("isSessionPastLifetime", () => {
  const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
  const HOUR = 60 * 60 * 1000;
  const cap = (hours: number | undefined) => ({ SESSION_ABSOLUTE_LIFETIME_HOURS: hours });
  const own = (hours: number) => ({
    session: { createdAt: new Date(NOW - hours * HOUR), token: "x".repeat(32) },
  });
  const borrowed = (hours: number) => ({
    session: { createdAt: new Date(NOW - hours * HOUR), impersonatedBy: "admin-1" },
  });
  const handoff = (hours: number) => ({
    session: {
      createdAt: new Date(NOW - hours * HOUR),
      token: `${ssoSessionTokenPrefix("portal")}${"ab".repeat(32)}`,
    },
  });

  it("applies the operator cap to an ordinary session, and nothing when it is unset", () => {
    expect(isSessionPastLifetime(own(30), cap(24), NOW)).toBe(true);
    expect(isSessionPastLifetime(own(23), cap(24), NOW)).toBe(false);
    expect(isSessionPastLifetime(own(10_000), cap(undefined), NOW)).toBe(false);
    expect(isSessionPastLifetime(own(10_000), {}, NOW)).toBe(false);
  });

  it("applies the one-hour cap to a borrowed session whatever the operator cap says", () => {
    expect(isSessionPastLifetime(borrowed(2), cap(undefined), NOW)).toBe(true);
    expect(isSessionPastLifetime(borrowed(2), cap(24), NOW)).toBe(true);
    expect(isSessionPastLifetime(borrowed(0.5), cap(undefined), NOW)).toBe(false);
  });

  it("does not apply the one-hour cap to a session without the marker", () => {
    expect(isSessionPastLifetime(own(2), cap(undefined), NOW)).toBe(false);
    expect(
      isSessionPastLifetime(
        { session: { createdAt: new Date(NOW), impersonatedBy: "" } },
        cap(1),
        NOW,
      ),
    ).toBe(false);
  });

  it("ends a handoff session at its lifetime with the operator cap unset (F-82)", () => {
    expect(isSessionPastLifetime(handoff(9), {}, NOW)).toBe(true);
    expect(isSessionPastLifetime(handoff(7), {}, NOW)).toBe(false);
    expect(isSessionPastLifetime(handoff(9), { SSO_SESSION_LIFETIME_HOURS: 12 }, NOW)).toBe(false);
    expect(isSessionPastLifetime(handoff(13), { SSO_SESSION_LIFETIME_HOURS: 12 }, NOW)).toBe(true);
  });

  it("applies whichever bound is tighter to a handoff session", () => {
    // A generous operator cap does not extend it; a tight one still ends it.
    expect(isSessionPastLifetime(handoff(9), cap(168), NOW)).toBe(true);
    expect(
      isSessionPastLifetime(handoff(3), { ...cap(2), SSO_SESSION_LIFETIME_HOURS: 8 }, NOW),
    ).toBe(true);
  });

  it("does not apply the handoff lifetime to a session without the prefix", () => {
    expect(isSessionPastLifetime(own(9), {}, NOW)).toBe(false);
    expect(isSessionPastLifetime(own(9), { SSO_SESSION_LIFETIME_HOURS: 1 }, NOW)).toBe(false);
  });
});
