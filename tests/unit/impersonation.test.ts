import { describe, expect, it } from "vitest";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * The pure impersonation-marker reader shared by `getImpersonatorId`
 * (auth-guard) and the unified caller resolver (review #28). It must accept
 * both field spellings the admin plugin has used and yield `null` for every
 * non-impersonated shape — a false positive here would lock a plain user out
 * of the org switcher, a false negative would reopen the P0-1 pivot.
 */
describe("readImpersonatorId", () => {
  it("reads the camelCase marker Better Auth's admin plugin stamps", () => {
    expect(readImpersonatorId({ session: { impersonatedBy: "admin-1" } })).toBe("admin-1");
  });

  it("reads the snake_case column spelling (plugin version drift)", () => {
    expect(readImpersonatorId({ session: { impersonated_by: "admin-2" } })).toBe("admin-2");
  });

  it("prefers the camelCase field when both are present", () => {
    expect(
      readImpersonatorId({ session: { impersonatedBy: "camel", impersonated_by: "snake" } }),
    ).toBe("camel");
  });

  it("is null for a plain session, an explicit null marker, or an empty string", () => {
    expect(readImpersonatorId({ session: { id: "s-1" } })).toBeNull();
    expect(readImpersonatorId({ session: { impersonatedBy: null } })).toBeNull();
    expect(readImpersonatorId({ session: { impersonatedBy: "" } })).toBeNull();
    expect(readImpersonatorId({ user: { id: "ba-1" } })).toBeNull();
  });

  it("is null for no session at all and for non-object input", () => {
    expect(readImpersonatorId(null)).toBeNull();
    expect(readImpersonatorId(undefined)).toBeNull();
    expect(readImpersonatorId("admin-1")).toBeNull();
  });

  it("ignores a non-string marker (never coerces an object into an actor id)", () => {
    expect(readImpersonatorId({ session: { impersonatedBy: { id: "x" } } })).toBeNull();
    expect(readImpersonatorId({ session: { impersonatedBy: 42 } })).toBeNull();
  });
});
