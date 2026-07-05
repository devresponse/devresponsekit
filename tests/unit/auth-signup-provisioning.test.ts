import { afterEach, describe, expect, it } from "vitest";
import {
  isSignupProvisioningSuppressed,
  setSignupProvisioningSuppressed,
  shouldProvisionSelfSignup,
} from "@/lib/auth-signup-provisioning";

/**
 * Gating for the AUTH-5 sign-up auto-provisioning hook
 * (`databaseHooks.user.create.after` in `src/lib/auth.ts`). The hook must
 * provision `app_users` for genuine email/password self-registrations only —
 * NOT for OAuth (the session hook covers it), admin / machine-API creation
 * (which provisions itself), or seeding (which provisions itself and suppresses
 * the hook). Getting this wrong double-provisions or pollutes memberships.
 */
describe("shouldProvisionSelfSignup", () => {
  afterEach(() => setSignupProvisioningSuppressed(false));

  it("provisions the email/password self-registration endpoint", () => {
    expect(shouldProvisionSelfSignup({ path: "/sign-up/email" })).toBe(true);
  });

  it("skips OAuth callbacks — the session hook provisions those", () => {
    expect(shouldProvisionSelfSignup({ path: "/callback/google" })).toBe(false);
    expect(shouldProvisionSelfSignup({ path: "/callback/microsoft" })).toBe(false);
    expect(shouldProvisionSelfSignup({ path: "/callback/github" })).toBe(false);
  });

  it("skips admin / machine-API creation — the route provisions app_users itself", () => {
    expect(shouldProvisionSelfSignup({ path: "/admin/create-user" })).toBe(false);
  });

  it("skips a missing context or path", () => {
    expect(shouldProvisionSelfSignup(undefined)).toBe(false);
    expect(shouldProvisionSelfSignup(null)).toBe(false);
    expect(shouldProvisionSelfSignup({})).toBe(false);
    expect(shouldProvisionSelfSignup({ path: null })).toBe(false);
  });

  it("stands down while seeding is in progress (suppression flag)", () => {
    expect(isSignupProvisioningSuppressed()).toBe(false);
    setSignupProvisioningSuppressed(true);
    // Even the self-registration path is skipped while suppressed.
    expect(shouldProvisionSelfSignup({ path: "/sign-up/email" })).toBe(false);
    expect(isSignupProvisioningSuppressed()).toBe(true);
    setSignupProvisioningSuppressed(false);
    expect(shouldProvisionSelfSignup({ path: "/sign-up/email" })).toBe(true);
  });
});
