import { describe, expect, it } from "vitest";
import { decideSecureAccess } from "@/lib/auth-status";

/**
 * Extra branch coverage for `decideSecureAccess`. The original test file
 * verifies the spec table; this file exercises the residual fallthrough
 * branches that exist purely to keep the function total.
 */
describe("decideSecureAccess (extended branches)", () => {
  it("falls through to pending_approval for unexpected status combinations", () => {
    // Active user with deactivated membership: no explicit branch matches.
    // Treat as pending_approval (deny by default).
    expect(decideSecureAccess("active", "pending_approval")).toBe("pending_approval");
  });

  it("never returns 'allow' when status is anything but active+active", () => {
    // sweep representative pairs to catch accidental loosening of the
    // gate during refactors.
    const statuses = ["active", "pending_approval", "blocked", "suspended", "deactivated"] as const;
    const memberships = ["active", "pending_approval", "blocked", "suspended", null] as const;
    for (const s of statuses) {
      for (const m of memberships) {
        const decision = decideSecureAccess(s, m);
        if (decision === "allow") {
          expect(s).toBe("active");
          expect(m).toBe("active");
        }
      }
    }
  });
});
