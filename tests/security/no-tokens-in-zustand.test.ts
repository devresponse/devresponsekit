import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §29.7.8 — Zustand persisted state must NEVER include auth tokens,
 * session ids, role decisions, or any authority-bearing data.
 *
 * The store is loaded as source rather than imported because importing it
 * would drag in the React/Zustand client runtime; we only need to assert
 * the static `partialize` whitelist.
 */
describe("zustand persisted state", () => {
  const storeSource = readFileSync(
    path.resolve(__dirname, "../../src/stores/app-shell-store.ts"),
    "utf8",
  );

  it("only persists layout preference fields via partialize", () => {
    // Capture the partialize whitelist and assert it contains only
    // `visibility` and `density`.
    const match = storeSource.match(/partialize:\s*\(state\)\s*=>\s*\(\{([\s\S]*?)\}\)/);
    expect(match, "partialize block not found").toBeTruthy();
    const body = match![1];

    const allowed = ["visibility", "density"];
    const forbidden = [
      "token",
      "accessToken",
      "refreshToken",
      "session",
      "sessionId",
      "userId",
      "roles",
      "permissions",
      "email",
      "password",
    ];

    for (const key of allowed) {
      expect(body).toContain(`${key}:`);
    }
    for (const key of forbidden) {
      expect(body, `partialize should not persist ${key}`).not.toContain(`${key}:`);
    }
  });

  it("uses a stable storage name that does not collide with auth cookies", () => {
    expect(storeSource).toMatch(/name:\s*"enterprise-app-shell"/);
    // Better Auth stores its session in HTTP-only cookies, not localStorage.
    expect(storeSource).not.toMatch(/better-auth/i);
  });
});
