import { describe, expect, it } from "vitest";
import {
  API_SCOPE_CATALOG,
  isAccountScope,
  isScopeNameable,
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

describe("scope-nameable permission keys", () => {
  it("a catalog key, or a key under an issuable wildcard's prefix, can be named by a scope", () => {
    expect(isScopeNameable("admin.users.read")).toBe(true);
    expect(isScopeNameable("account.read")).toBe(true);
    // A custom key under `admin.`: the issuable `admin.*` wildcard authorizes it.
    expect(isScopeNameable("admin.reports.view")).toBe(true);
    expect(scopesAuthorize(["admin.*"], "admin.reports.view")).toBe(true);
  });

  it("no scope can name the baseline, the superuser marker, audit.view or a custom app key", () => {
    for (const key of ["shell.view", "superuser", "audit.view", "crm.deals.write", "admin"]) {
      expect(isScopeNameable(key), key).toBe(false);
    }
    // No issuable wildcard reaches them either: the one that would is refused.
    expect(ungrantableScopes(["crm.deals.write"], ["crm.*"])).toEqual(["crm.*"]);
  });

  it("every catalog key is nameable, because each has an interior dot", () => {
    for (const key of API_SCOPE_CATALOG) {
      expect(key.indexOf("."), key).toBeGreaterThan(0);
      expect(isScopeNameable(key), key).toBe(true);
    }
  });

  it("matches the whole first segment, dot included, not a shorter prefix of it", () => {
    // `admin` and `account` start catalog scopes; these roots only share letters.
    for (const key of ["adminx.reports.view", "accounts.read", "a.b", ".admin.users.read"]) {
      expect(isScopeNameable(key), key).toBe(false);
    }
  });
});

describe("scope algebra edges", () => {
  it("a non-wildcard grant never matches by prefix", () => {
    expect(scopeMatches("admin.users.read", "admin.users.reax")).toBe(false);
  });

  it("an unknown scope is ungrantable even when the creator holds that key", () => {
    // A custom app permission is outside the catalog, so no credential can carry it.
    expect(ungrantableScopes(["crm.deals.write"], ["crm.deals.write"])).toEqual([
      "crm.deals.write",
    ]);
  });
});
