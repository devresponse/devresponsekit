import { describe, expect, it, vi } from "vitest";
import type * as EnterpriseAppsModule from "@/lib/admin/enterprise-apps";

/**
 * `src/lib/sso-launch-return.ts` promises not to lean on `APP_ID_RE`, a regex
 * the admin surface owns and nothing pins on this module's behalf: it bounds
 * the id's length itself and RECONSTRUCTS its output rather than splicing input
 * into it. With the real regex neither promise is observable, because the
 * regex also caps an id at 128 characters and refuses `?`, `#` and `&`. That is
 * why Stryker's mutants of the length check survived (I-11).
 *
 * This file widens the regex to accept anything, so the module's own checks are
 * the only thing between the input and the path it builds. It is a separate
 * file because `vi.mock` applies to every test in a file, and
 * `sso-launch-return.test.ts` needs the real regex.
 */
vi.mock("@/lib/admin/enterprise-apps", async () => ({
  ...(await vi.importActual<typeof EnterpriseAppsModule>("@/lib/admin/enterprise-apps")),
  APP_ID_RE: /^[\s\S]*$/,
}));

import {
  buildSsoLaunchApiPath,
  buildSsoLaunchReturnPath,
  parseSsoLaunchParams,
} from "@/lib/sso-launch-return";

describe("sso-launch-return without APP_ID_RE's help", () => {
  it("refuses an empty id", () => {
    expect(parseSsoLaunchParams("", "en")).toBeNull();
    expect(buildSsoLaunchReturnPath("", "en")).toBeNull();
  });

  it("refuses an id past 128 characters and accepts one at exactly 128", () => {
    expect(parseSsoLaunchParams("a".repeat(129), "en")).toBeNull();
    expect(buildSsoLaunchApiPath("a".repeat(129), "en")).toBeNull();
    expect(parseSsoLaunchParams("a".repeat(128), "en")?.applicationId).toBe("a".repeat(128));
  });

  it("encodes an id carrying `&`, `#`, `?` and `/` instead of splicing it into the path", () => {
    const id = "../x&locale=zz#frag?y=1";
    for (const [built, pathname] of [
      [buildSsoLaunchReturnPath(id, "fr"), "/fr/sso/launch"],
      [buildSsoLaunchApiPath(id, "fr"), "/api/sso/launch"],
    ] as const) {
      expect(built).not.toBeNull();
      const url = new URL(built!, "https://example.test");
      expect(url.pathname).toBe(pathname);
      expect(url.hash).toBe("");
      expect([...url.searchParams.keys()]).toEqual(["applicationId", "locale"]);
      expect(url.searchParams.get("applicationId")).toBe(id);
      expect(url.searchParams.get("locale")).toBe("fr");
    }
  });
});
