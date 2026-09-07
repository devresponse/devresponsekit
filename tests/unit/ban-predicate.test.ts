import { describe, expect, it } from "vitest";
import { isBanActive } from "@/lib/ban-status";

/**
 * The pure ban predicate (review #126). Every credential path — Better Auth
 * sign-in, the machine-API resolver, and the server-only SSO session plugin —
 * now answers "is this user banned right now?" here, so the rules are pinned
 * once. An elapsed temporary ban MUST read as not-banned; anything ambiguous
 * MUST read as banned.
 */
describe("isBanActive", () => {
  const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

  it("is false for an unbanned user", () => {
    expect(isBanActive({}, NOW)).toBe(false);
    expect(isBanActive({ banned: false }, NOW)).toBe(false);
    expect(isBanActive({ banned: null }, NOW)).toBe(false);
    // An expiry without the flag is meaningless — the flag is the switch.
    expect(isBanActive({ banned: false, banExpires: new Date(NOW + 60_000) }, NOW)).toBe(false);
  });

  it("is true for an indefinite ban (no expiry)", () => {
    expect(isBanActive({ banned: true }, NOW)).toBe(true);
    expect(isBanActive({ banned: true, banExpires: null }, NOW)).toBe(true);
  });

  it("is true while a temporary ban is still running", () => {
    expect(isBanActive({ banned: true, banExpires: new Date(NOW + 1) }, NOW)).toBe(true);
    expect(
      isBanActive({ banned: true, banExpires: new Date(NOW + 86_400_000).toISOString() }, NOW),
    ).toBe(true);
  });

  it("is false once the temporary ban has elapsed", () => {
    expect(isBanActive({ banned: true, banExpires: new Date(NOW - 1) }, NOW)).toBe(false);
    expect(
      isBanActive({ banned: true, banExpires: new Date(NOW - 86_400_000).toISOString() }, NOW),
    ).toBe(false);
    // Exactly at the boundary the ban is over.
    expect(isBanActive({ banned: true, banExpires: new Date(NOW) }, NOW)).toBe(false);
  });

  it("accepts an epoch-millisecond expiry", () => {
    expect(isBanActive({ banned: true, banExpires: NOW + 5_000 }, NOW)).toBe(true);
    expect(isBanActive({ banned: true, banExpires: NOW - 5_000 }, NOW)).toBe(false);
  });

  it("fails closed on an unparseable expiry", () => {
    expect(isBanActive({ banned: true, banExpires: "whenever" }, NOW)).toBe(true);
    expect(isBanActive({ banned: true, banExpires: new Date("nope") }, NOW)).toBe(true);
  });

  it("defaults `nowMs` to the wall clock", () => {
    expect(isBanActive({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isBanActive({ banned: true, banExpires: new Date(Date.now() - 60_000) })).toBe(false);
  });
});
