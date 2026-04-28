import { describe, expect, it } from "vitest";
import { decideSecureAccess } from "@/lib/auth-status";

describe("decideSecureAccess", () => {
  it("allows active user with active membership", () => {
    expect(decideSecureAccess("active", "active")).toBe("allow");
  });

  it("blocks blocked, suspended, deactivated users regardless of membership", () => {
    expect(decideSecureAccess("blocked", "active")).toBe("blocked");
    expect(decideSecureAccess("suspended", "active")).toBe("blocked");
    expect(decideSecureAccess("deactivated", "active")).toBe("blocked");
  });

  it("returns pending_approval for pending users", () => {
    expect(decideSecureAccess("pending_approval", null)).toBe("pending_approval");
    expect(decideSecureAccess("pending_approval", "active")).toBe("pending_approval");
    expect(decideSecureAccess("pending_approval", "pending_approval")).toBe("pending_approval");
  });

  it("returns pending_approval when membership is missing", () => {
    expect(decideSecureAccess("active", null)).toBe("pending_approval");
  });

  it("blocks if membership is blocked or suspended", () => {
    expect(decideSecureAccess("active", "blocked")).toBe("blocked");
    expect(decideSecureAccess("active", "suspended")).toBe("blocked");
  });
});
