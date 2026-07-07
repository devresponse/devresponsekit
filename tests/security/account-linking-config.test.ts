import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §29.7.9 — accounts may be linked ONLY by verified email. We assert
 * Better Auth's `accountLinking` configuration directly from source so a
 * regression that flips `allowDifferentEmails` to `true`, disables the
 * verified-only enforcement, or trusts a provider fails CI.
 *
 * `trustedProviders` must stay EMPTY: better-auth does not use it to
 * restrict which providers may link — listing a provider EXEMPTS it from
 * the incoming profile's `emailVerified` requirement. Trusting the
 * multi-tenant Microsoft provider would allow the "nOAuth" account
 * takeover (any Entra tenant admin can assert an arbitrary unverified
 * email). The behavioral counterpart of this pin lives in
 * account-linking-behavior.test.ts.
 */
describe("account linking configuration", () => {
  const authSource = readFileSync(path.resolve(__dirname, "../../src/lib/auth.ts"), "utf8");

  it("enables account linking", () => {
    expect(authSource).toMatch(/accountLinking:\s*\{[\s\S]*?enabled:\s*true/);
  });

  it("forbids linking accounts with different emails", () => {
    expect(authSource).toMatch(/allowDifferentEmails:\s*false/);
  });

  it("trusts NO provider to bypass the verified-email requirement", () => {
    const match = authSource.match(/trustedProviders:\s*\[([^\]]*)\]/);
    expect(match, "trustedProviders not found").toBeTruthy();
    expect(match?.[1]?.trim()).toBe("");
  });

  it("does not disable the local verified-email requirement", () => {
    // `requireLocalEmailVerified` defaults to true; the config must not
    // opt out of it.
    expect(authSource).not.toMatch(/requireLocalEmailVerified:\s*false/);
  });
});
