import { describe, expect, it } from "vitest";
import {
  ACCOUNT_WRITE_SCOPES,
  isOnBehalfOfAnother,
  reachesAccountWriteScope,
  unissuableScopes,
  type CredentialIssuer,
} from "@/lib/api-auth/issuance";
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

/**
 * The shared credential-issuance rule (F-01), exercised on its own. The route
 * tests prove each path calls it; these pin what it decides.
 */

const ALICE = "app-alice";
const BOB = "app-bob";

function issuer(overrides: Partial<CredentialIssuer> = {}): CredentialIssuer {
  return {
    appUserId: ALICE,
    permissions: ["admin.apikeys.manage", "admin.users.read"],
    grantedScopes: null,
    impersonatorId: null,
    ...overrides,
  };
}

function issue(ownerAppUserId: string, scopes: string[], by: Partial<CredentialIssuer> = {}) {
  return unissuableScopes({ issuer: issuer(by), ownerAppUserId, scopes });
}

describe("ACCOUNT_WRITE_SCOPES", () => {
  it("is every account scope except the read-only one", () => {
    expect([...ACCOUNT_WRITE_SCOPES].sort()).toEqual([
      "account.apikeys.manage",
      "account.preferences.write",
      "account.profile.write",
    ]);
  });
});

describe("reachesAccountWriteScope", () => {
  it.each([
    ["account.apikeys.manage", true],
    ["account.profile.write", true],
    ["account.preferences.write", true],
    ["account.*", true],
    ["account.apikeys.*", true],
    ["*", true],
    ["account.read", false],
    ["admin.users.read", false],
    ["admin.*", false],
  ])("%s → %s", (scope, expected) => {
    expect(reachesAccountWriteScope(scope)).toBe(expected);
  });
});

describe("isOnBehalfOfAnother", () => {
  it("is false for the issuer's own credential", () => {
    expect(isOnBehalfOfAnother({ issuer: issuer(), ownerAppUserId: ALICE })).toBe(false);
  });

  it("is true for another principal", () => {
    expect(isOnBehalfOfAnother({ issuer: issuer(), ownerAppUserId: BOB })).toBe(true);
  });

  it("is true for an IMPERSONATED session, which only looks like the owner", () => {
    // The session carries the borrowed user's appUserId; the impersonator is
    // not that user.
    expect(
      isOnBehalfOfAnother({
        issuer: issuer({ appUserId: BOB, impersonatorId: "ba-admin" }),
        ownerAppUserId: BOB,
      }),
    ).toBe(true);
  });

  it("treats an UNPROVISIONED issuer as never the owner (fail closed)", () => {
    expect(isOnBehalfOfAnother({ issuer: issuer({ appUserId: null }), ownerAppUserId: BOB })).toBe(
      true,
    );
  });
});

describe("unissuableScopes", () => {
  it("allows every account scope on the issuer's OWN credential", () => {
    expect(
      issue(ALICE, ["account.read", "account.apikeys.manage", "account.profile.write"]),
    ).toEqual([]);
  });

  it("refuses the account-WRITING scopes on another's credential, in request order", () => {
    expect(
      issue(BOB, [
        "admin.users.read",
        "account.apikeys.manage",
        "account.read",
        "account.profile.write",
      ]),
    ).toEqual(["account.apikeys.manage", "account.profile.write"]);
  });

  it("keeps account.read grantable on behalf (read-only, tenant-confined introspection)", () => {
    expect(issue(BOB, ["account.read"])).toEqual([]);
  });

  it("refuses account-writing scopes to an impersonated session on the borrowed user's own key", () => {
    expect(
      issue(BOB, ["account.apikeys.manage"], { appUserId: BOB, impersonatorId: "ba-admin" }),
    ).toEqual(["account.apikeys.manage"]);
  });

  it("still applies the actor bound: no admin scope the issuer does not hold", () => {
    expect(issue(BOB, ["admin.users.read", "admin.roles.assign"])).toEqual(["admin.roles.assign"]);
    expect(issue(ALICE, ["admin.roles.assign"])).toEqual(["admin.roles.assign"]);
  });

  it("bounds a BEARER issuer by its own scopes, not its owner's permissions", () => {
    expect(
      issue(BOB, ["admin.users.read"], {
        permissions: ["admin.apikeys.manage", "admin.users.read"],
        grantedScopes: ["admin.apikeys.manage"],
      }),
    ).toEqual(["admin.users.read"]);
  });

  it("refuses a wildcard that expands over account-writing scopes on another's credential", () => {
    expect(issue(BOB, ["account.*"])).toEqual(["account.*"]);
  });

  it("refuses unknown scopes whoever the owner is", () => {
    expect(issue(ALICE, ["not.a.scope"])).toEqual(["not.a.scope"]);
  });

  it("returns each refused scope once", () => {
    // `account.*` is refused by BOTH halves of the rule (the actor holds no
    // account wildcard, and it reaches the writing scopes on another's key).
    expect(issue(BOB, ["account.*"])).toHaveLength(1);
  });
});

describe("F-05: on-behalf issuance is bounded by scope ∩ the issuer's live permissions", () => {
  // The key was scoped when its owner held admin.users.delete; the owner has
  // since been downgraded. Its grant still NAMES the scope — inert at use,
  // where the guards intersect with live permissions.
  const staleBearer = {
    permissions: ["admin.clients.manage"],
    grantedScopes: ["admin.clients.manage", "admin.users.delete"],
  };

  it("refuses conferring the stale excess on ANOTHER principal (who does hold it)", () => {
    expect(issue(BOB, ["admin.users.delete", "admin.clients.manage"], staleBearer)).toEqual([
      "admin.users.delete",
    ]);
  });

  it("allows the same credential re-issuing its OWN owner's credential (confers nothing)", () => {
    // e.g. a key rotating itself after its owner was downgraded.
    expect(issue(ALICE, ["admin.users.delete", "admin.clients.manage"], staleBearer)).toEqual([]);
  });

  it("an on-behalf bearer wildcard needs the issuer to hold every key under it", () => {
    const usersKeys = API_SCOPE_CATALOG.filter((k) => k.startsWith("admin.users."));
    expect(
      issue(BOB, ["admin.users.*"], { permissions: usersKeys, grantedScopes: ["admin.users.*"] }),
    ).toEqual([]);
    expect(
      issue(BOB, ["admin.users.*"], {
        permissions: usersKeys.slice(1),
        grantedScopes: ["admin.users.*"],
      }),
    ).toEqual(["admin.users.*"]);
  });

  it("an impersonated session counts as on-behalf, so it is bounded too", () => {
    expect(
      issue(BOB, ["admin.users.delete"], {
        ...staleBearer,
        appUserId: BOB,
        impersonatorId: "ba-admin",
      }),
    ).toEqual(["admin.users.delete"]);
  });
});
