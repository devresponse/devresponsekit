import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANY_ADMIN_PERMISSION,
  SHELL_BASELINE_PERMISSION,
  SUPERADMIN_PERMISSION,
  canAccessAdminConsole,
} from "@/lib/admin/permissions";

/**
 * NAVK: the shell's "Administration Console" switcher entry is gated on
 * `canAccessAdminConsole`, and a nav gate must equal its destination's guard.
 * The destination is the console's layout, which calls
 * `checkAdminPermissionServer([...ANY_ADMIN_PERMISSION])` and `notFound()`s a
 * denial. These run the helper against that REAL guard over arbitrary grant
 * sets, and pin that the layout and the console's landing page still pass it
 * that exact argument, so the link can neither show a dead end nor hide a
 * console the caller may open.
 *
 * Only the guard's inputs are stubbed: the session, its access context (the
 * same session-resolved context the secure layout gates on), and the audit
 * row a denial writes.
 */
const access = vi.hoisted(() => ({ permissions: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: async () => ({ user: { id: "ba-1" }, session: { id: "s-1" } }),
}));
vi.mock("@/lib/session-access.server", () => ({
  getSessionAccessContext: async () => ({
    appUserId: "u-1",
    primaryEmail: "u@x.com",
    status: "active",
    organizationId: "o-1",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: access.permissions,
  }),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: async () => undefined }));

beforeEach(() => {
  access.permissions = [];
});
afterEach(() => vi.resetModules());

const ADMIN_DIR = join(
  fileURLToPath(new URL("../../src", import.meta.url)),
  "app",
  "[locale]",
  "(secure)",
  "app",
  "administrator",
);

describe("canAccessAdminConsole (NAVK)", () => {
  it("refuses no permissions and non-admin permissions only", () => {
    expect(canAccessAdminConsole([])).toBe(false);
    expect(canAccessAdminConsole([SHELL_BASELINE_PERMISSION, "audit.view"])).toBe(false);
    // Near misses are not catalog keys.
    expect(canAccessAdminConsole(["admin", "admin.users", "admin.users.read "])).toBe(false);
  });

  it.each([...ANY_ADMIN_PERMISSION])("admits %s on its own", (key) => {
    expect(canAccessAdminConsole([SHELL_BASELINE_PERMISSION, key])).toBe(true);
  });

  it("admits the SUPERADMIN marker without any admin.* key", () => {
    expect(canAccessAdminConsole([SUPERADMIN_PERMISSION])).toBe(true);
  });

  it("agrees with the console layout's guard on any grant set", async () => {
    const { checkAdminPermissionServer } = await import("@/lib/admin/permissions.server");
    const pool = [
      ...ANY_ADMIN_PERMISSION,
      SUPERADMIN_PERMISSION,
      SHELL_BASELINE_PERMISSION,
      "audit.view",
      "admin.users",
    ];
    const grants = fc.array(fc.oneof(fc.constantFrom(...pool), fc.string()), { maxLength: 6 });

    await fc.assert(
      fc.asyncProperty(grants, async (permissions) => {
        access.permissions = permissions;
        const guard = await checkAdminPermissionServer([...ANY_ADMIN_PERMISSION]);
        expect(typeof guard === "object").toBe(canAccessAdminConsole(permissions));
      }),
      { numRuns: 300 },
    );
  });

  it("is the argument the console layout and its landing page guard on", () => {
    const layout = readFileSync(join(ADMIN_DIR, "layout.tsx"), "utf8");
    const page = readFileSync(join(ADMIN_DIR, "page.tsx"), "utf8");
    for (const source of [layout, page]) {
      const calls = [...source.matchAll(/await checkAdminPermissionServer\(([^)]*)\)/g)].map(
        (m) => m[1],
      );
      expect(calls).toEqual(["[...ANY_ADMIN_PERMISSION]"]);
    }
    // The layout is the one that refuses: a denial is a 404.
    expect(layout).toMatch(
      /if \(guard === "denied" \|\| guard === "unauthenticated"\) \{\s*notFound\(\);/,
    );
  });
});
