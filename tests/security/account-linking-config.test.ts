import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §29.7.9 — accounts may be linked ONLY by verified email. We assert
 * Better Auth's `accountLinking` configuration directly from source so a
 * regression that flips `allowDifferentEmails` to `true`, removes
 * verified-only enforcement, or adds an untrusted provider fails CI.
 */
describe("account linking configuration", () => {
  const authSource = readFileSync(path.resolve(__dirname, "../../src/lib/auth.ts"), "utf8");

  it("enables account linking", () => {
    expect(authSource).toMatch(/accountLinking:\s*\{[\s\S]*?enabled:\s*true/);
  });

  it("forbids linking accounts with different emails", () => {
    expect(authSource).toMatch(/allowDifferentEmails:\s*false/);
  });

  it("only trusts the supported social providers for linking", () => {
    const match = authSource.match(/trustedProviders:\s*\[([^\]]*)\]/);
    expect(match, "trustedProviders not found").toBeTruthy();
    const list = match![1];
    expect(list).toContain('"google"');
    expect(list).toContain('"microsoft"');
    expect(list).toContain('"github"');
    // Email/password is intentionally NOT a trusted provider — those
    // accounts cannot be auto-linked from a social profile claim.
    expect(list).not.toContain('"email"');
    expect(list).not.toContain('"credentials"');
  });
});
