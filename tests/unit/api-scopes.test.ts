import { describe, expect, it } from "vitest";
import {
  isAccountScope,
  normalizeScopes,
  scopeMatches,
  scopesAuthorize,
  ungrantableScopes,
  ungrantableScopesForCaller,
} from "@/lib/api-auth/scopes";

/**
 * Unit coverage for the scope model — the heart of least-privilege.
 */
describe("scope matching", () => {
  it("matches exact and wildcard scopes", () => {
    expect(scopeMatches("admin.users.read", "admin.users.read")).toBe(true);
    expect(scopeMatches("admin.users.*", "admin.users.read")).toBe(true);
    expect(scopeMatches("admin.users.*", "admin.roles.read")).toBe(false);
    expect(scopeMatches("*", "anything.at.all")).toBe(true);
  });

  it("treats a null grant as full authority and an empty grant as none", () => {
    expect(scopesAuthorize(null, "admin.users.read")).toBe(true);
    expect(scopesAuthorize([], "admin.users.read")).toBe(false);
    expect(scopesAuthorize(["admin.users.read"], "admin.users.read")).toBe(true);
    expect(scopesAuthorize(["admin.users.*"], "admin.users.read")).toBe(true);
  });

  it("normalizes array and space-delimited scope inputs", () => {
    expect(normalizeScopes("a b  c")).toEqual(["a", "b", "c"]);
    expect(normalizeScopes(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeScopes(null)).toEqual([]);
  });

  it("identifies account scopes", () => {
    expect(isAccountScope("account.profile.write")).toBe(true);
    expect(isAccountScope("admin.users.read")).toBe(false);
  });
});

describe("grantability (least privilege)", () => {
  it("lets a holder grant admin scopes they hold and any account scope", () => {
    const held = ["admin.users.read", "admin.users.manage"];
    expect(ungrantableScopes(held, ["admin.users.read", "account.read"])).toEqual([]);
  });

  it("blocks granting admin scopes the creator lacks", () => {
    expect(ungrantableScopes(["admin.users.read"], ["admin.orgs.delete"])).toEqual([
      "admin.orgs.delete",
    ]);
  });

  it("rejects unknown scopes", () => {
    expect(ungrantableScopes(["admin.users.read"], ["not.a.real.scope"])).toEqual([
      "not.a.real.scope",
    ]);
  });

  it("a bearer credential can only delegate scopes it already holds", () => {
    // Owner holds broad admin perms, but the calling KEY is narrowly scoped.
    const ownerPerms = ["admin.users.read", "admin.users.manage", "admin.orgs.delete"];
    const callerScopes = ["admin.users.read"];
    // Trying to mint a broader key must fail for the scopes outside the caller's grant.
    expect(ungrantableScopesForCaller(ownerPerms, callerScopes, ["admin.users.read"])).toEqual([]);
    expect(ungrantableScopesForCaller(ownerPerms, callerScopes, ["admin.orgs.delete"])).toEqual([
      "admin.orgs.delete",
    ]);
  });

  it("a cookie caller (null scopes) delegates with full owner authority", () => {
    expect(
      ungrantableScopesForCaller(["admin.users.read"], null, ["admin.users.read", "account.read"]),
    ).toEqual([]);
  });

  it("a wildcard is grantable only when the creator holds EVERY key under the prefix", () => {
    const allAccount = [
      "account.read",
      "account.profile.write",
      "account.preferences.write",
      "account.apikeys.manage",
    ];
    // Holds all four account.* keys → may grant the account.* wildcard.
    expect(ungrantableScopes(allAccount, ["account.*"])).toEqual([]);
    // Missing some of the covered keys → the wildcard is NOT grantable.
    expect(ungrantableScopes(["account.read"], ["account.*"])).toEqual(["account.*"]);
  });

  it("rejects a wildcard whose prefix covers no known scope", () => {
    expect(ungrantableScopes(["admin.users.read"], ["zzz.nothing.*"])).toEqual(["zzz.nothing.*"]);
  });
});
