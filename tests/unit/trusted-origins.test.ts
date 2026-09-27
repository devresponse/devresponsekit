import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrustedOrigins, parseOrigin } from "@/lib/trusted-origins";

/**
 * The trusted-origin allow-list feeds BOTH CSRF layers: Better Auth's
 * `trustedOrigins` and the administrator origin guard. `origin-guard.test.ts`
 * stubs `getTrustedOrigins` to control the list. `auth-config.test.ts` does
 * assert the built list, through Better Auth's options, but only with valid
 * entries and ASCII padding (which the URL parser strips by itself), so
 * Stryker measured the module at 68% (I-11): a mutant that kept an unparsable
 * entry, returned undefined for one, or stopped trimming survived. This file
 * adds the cases that test leaves out: unparsable and empty entries,
 * non-ASCII whitespace, the order of the union, and each variable read on
 * its own.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sets exactly the three variables the allow-list reads (undefined = unset). */
function stubOrigins(env: { app?: string; auth?: string; extras?: string }): void {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.app);
  vi.stubEnv("BETTER_AUTH_URL", env.auth);
  vi.stubEnv("ADMIN_TRUSTED_ORIGINS", env.extras);
}

describe("parseOrigin", () => {
  it("normalizes a URL to protocol//host, dropping path, query and fragment", () => {
    expect(parseOrigin("https://App.Example.com/admin/users?x=1#top")).toBe(
      "https://app.example.com",
    );
  });

  it("keeps a non-default port and drops a default one", () => {
    expect(parseOrigin("http://localhost:3000/sign-in")).toBe("http://localhost:3000");
    expect(parseOrigin("https://app.example.com:8443")).toBe("https://app.example.com:8443");
    expect(parseOrigin("https://app.example.com:443")).toBe("https://app.example.com");
  });

  it("returns null (not undefined, not a string) for a missing or unparsable value", () => {
    for (const value of [null, undefined, "", "not a url", "/relative/path"]) {
      expect(parseOrigin(value)).toBeNull();
    }
  });
});

describe("getTrustedOrigins", () => {
  it("is empty when no origin variable is set", () => {
    stubOrigins({});
    expect(getTrustedOrigins()).toEqual([]);
  });

  it("unions the app URL, the auth URL and every ADMIN_TRUSTED_ORIGINS entry, in that order", () => {
    stubOrigins({
      app: "https://app.example.com/dashboard",
      auth: "https://auth.example.com",
      extras: "https://preview.example.com,https://prod.example.com/",
    });
    expect(getTrustedOrigins()).toEqual([
      "https://app.example.com",
      "https://auth.example.com",
      "https://preview.example.com",
      "https://prod.example.com",
    ]);
  });

  it("reads ADMIN_TRUSTED_ORIGINS on its own, with the URL variables unset", () => {
    stubOrigins({ extras: "https://extra.example.com" });
    expect(getTrustedOrigins()).toEqual(["https://extra.example.com"]);
  });

  it("deduplicates after normalization, so the usual app URL = auth URL setup lists one origin", () => {
    stubOrigins({
      app: "https://app.example.com",
      auth: "https://app.example.com/api/auth",
      extras: "https://APP.example.com:443/",
    });
    expect(getTrustedOrigins()).toEqual(["https://app.example.com"]);
  });

  it("drops an unparsable entry instead of trusting it or failing the whole list", () => {
    stubOrigins({
      app: "not a url",
      auth: "https://auth.example.com",
      extras: "garbage,https://ok.example.com",
    });
    expect(getTrustedOrigins()).toEqual(["https://auth.example.com", "https://ok.example.com"]);
  });

  it("ignores empty entries and trims whitespace around each extra", () => {
    // A no-break space or a byte-order mark (pasted from a document or a
    // dashboard) is whitespace to `String.prototype.trim` but NOT to the URL
    // parser, which strips only ASCII space and control characters. Without
    // the trim, such an entry would silently fall out of the list and every
    // admin mutation from that origin would be refused. Written as escapes so
    // the characters stay visible and no editor can normalise them away.
    stubOrigins({
      extras:
        " https://a.example.com , ,\u00a0https://b.example.com\u00a0,\ufeffhttps://c.example.com,",
    });
    expect(getTrustedOrigins()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });
});
