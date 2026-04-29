// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useAppShellStore } from "@/stores/app-shell-store";

/**
 * Unit coverage for the Zustand `useAppShellStore`. Component tests
 * exercise specific actions through UI; this file pins the action API
 * directly so future refactors can't silently change the contract.
 *
 * Persistence is covered by the security test
 * `tests/security/no-tokens-in-zustand.test.ts` which inspects the
 * `partialize` whitelist.
 */
describe("app-shell-store", () => {
  afterEach(() => {
    useAppShellStore.getState().resetScope("root");
    useAppShellStore.getState().resetScope("workspace");
    useAppShellStore.getState().setDensity("compact");
  });

  it("starts with both scopes fully visible and density=compact", () => {
    const s = useAppShellStore.getState();
    expect(s.density).toBe("compact");
    expect(s.visibility.root.leftVisible).toBe(true);
    expect(s.visibility.workspace.footerVisible).toBe(true);
  });

  it("setRegionVisible updates only the targeted scope/region pair", () => {
    useAppShellStore.getState().setRegionVisible("root", "left", false);
    expect(useAppShellStore.getState().visibility.root.leftVisible).toBe(false);
    expect(useAppShellStore.getState().visibility.workspace.leftVisible).toBe(true);
  });

  it("toggleRegion flips the current visibility flag", () => {
    useAppShellStore.getState().toggleRegion("root", "right");
    expect(useAppShellStore.getState().visibility.root.rightVisible).toBe(false);
    useAppShellStore.getState().toggleRegion("root", "right");
    expect(useAppShellStore.getState().visibility.root.rightVisible).toBe(true);
  });

  it("setDensity persists between calls", () => {
    useAppShellStore.getState().setDensity("comfortable");
    expect(useAppShellStore.getState().density).toBe("comfortable");
  });

  it("resetScope returns the visibility to defaults", () => {
    useAppShellStore.getState().setRegionVisible("workspace", "footer", false);
    useAppShellStore.getState().resetScope("workspace");
    expect(useAppShellStore.getState().visibility.workspace.footerVisible).toBe(true);
  });
});
