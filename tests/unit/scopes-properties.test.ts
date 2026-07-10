import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  API_SCOPE_CATALOG,
  isKnownScope,
  normalizeScopes,
  scopeMatches,
  scopesAuthorize,
  ungrantableScopes,
  ungrantableScopesForCaller,
} from "@/lib/api-auth/scopes";

/**
 * PROPERTY-BASED tests for the permission ∩ scope algebra (fast-check). Example
 * tests pin known cases; these bound the whole input space, so a refactor that
 * lets a credential out-scope itself — the class behind the P0-2/P1-1 audit
 * findings — fails here even without a hand-written example.
 */

// Two-segment prefixes present in the catalog, used to build valid wildcards.
const PREFIXES = [...new Set(API_SCOPE_CATALOG.map((k) => k.split(".").slice(0, 2).join(".")))];

const knownScope = fc.constantFrom(...API_SCOPE_CATALOG);
const wildcard = fc.constantFrom(...PREFIXES).map((p) => `${p}.*`);
// A grant/requested scope: a mix of known keys, wildcards, the `*` sugar, and
// arbitrary junk — so the properties hold across hostile input, not just valid.
const anyScope = fc.oneof(knownScope, wildcard, fc.constant("*"), fc.string());
const scopeList = fc.array(anyScope, { maxLength: 8 });

describe("permission ∩ scope algebra (properties)", () => {
  it("a null grant authorizes every required permission (cookie full authority)", () => {
    fc.assert(fc.property(anyScope, (r) => scopesAuthorize(null, r) === true));
  });

  it("scopesAuthorize is exactly 'some granted scope matches'", () => {
    fc.assert(
      fc.property(scopeList, anyScope, (grant, r) => {
        expect(scopesAuthorize(grant, r)).toBe(grant.some((g) => scopeMatches(g, r)));
      }),
    );
  });

  it("an exact-held scope authorizes itself", () => {
    fc.assert(
      fc.property(knownScope, (s) => {
        expect(scopeMatches(s, s)).toBe(true);
        expect(scopesAuthorize([s], s)).toBe(true);
      }),
    );
  });

  it("a wildcard authorizes exactly the keys under its prefix (nothing else)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PREFIXES), knownScope, (prefix, key) => {
        expect(scopeMatches(`${prefix}.*`, key)).toBe(key.startsWith(`${prefix}.`));
      }),
    );
  });

  it("KEY INVARIANT: a bearer credential can never grant a scope its own grant does not authorize", () => {
    fc.assert(
      fc.property(scopeList, scopeList, scopeList, (callerPerms, grant, requested) => {
        const ungrantable = new Set(ungrantableScopesForCaller(callerPerms, grant, requested));
        for (const r of requested) {
          if (!ungrantable.has(r)) {
            // Allowed to grant r ⟹ r is a known scope AND authorized by the
            // credential's own granted scopes. A scoped-down key can't mint up.
            expect(isKnownScope(r)).toBe(true);
            expect(scopesAuthorize(grant, r)).toBe(true);
          }
        }
      }),
    );
  });

  it("a cookie session (null grant) delegates exactly to ungrantableScopes", () => {
    fc.assert(
      fc.property(scopeList, scopeList, (perms, requested) => {
        expect(ungrantableScopesForCaller(perms, null, requested)).toEqual(
          ungrantableScopes(perms, requested),
        );
      }),
    );
  });

  it("ungrantableScopes always returns a subset of the requested scopes", () => {
    fc.assert(
      fc.property(scopeList, scopeList, (perms, requested) => {
        const req = new Set(requested);
        for (const s of ungrantableScopes(perms, requested)) expect(req.has(s)).toBe(true);
      }),
    );
  });

  it("normalizeScopes is idempotent, trimmed, deduped, and never empty", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (raw) => {
        const n = normalizeScopes(raw);
        expect(normalizeScopes(n)).toEqual(n); // idempotent
        expect(new Set(n).size).toBe(n.length); // deduped
        for (const s of n) {
          expect(s).toBe(s.trim()); // trimmed
          expect(s.length).toBeGreaterThan(0); // non-empty
        }
      }),
    );
  });
});
