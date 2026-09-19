import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * IMP-1 systemic guard — the completeness critic for impersonation tenant
 * confinement.
 *
 * The confinement itself lives in `getUserAccessContext`, but it only runs
 * when the caller HANDS IT the session's `impersonatedBy` marker. That third
 * argument is optional, so a call site that simply forgets it resolves an
 * impersonated session exactly as before — the cookie pivot, silently
 * reopened, with every behavioural test still green. A point-in-time fix does
 * not stop the next call site from forgetting; these two scans do.
 *
 * SCAN 1 — every cookie-session caller goes through `getSessionAccessContext`
 * (src/lib/session-access.server.ts), which reads the marker off the session.
 * Only the modules that legitimately resolve a NON-session principal — a
 * bearer credential's bound org, a target user, a credential's owner — may
 * name `getUserAccessContext`, and each must say why here.
 *
 * SCAN 2 — the self-service account guard refuses impersonated sessions by
 * default (see `AccountAccessOptions`); a route that opts out with
 * `allowImpersonation: true` must be listed here with a reason, so re-opening
 * the credential surface is a reviewed decision rather than a copied line.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/**
 * Modules allowed to call `getUserAccessContext` directly, and WHY each one
 * is not resolving a cookie session. Everything else must use
 * `getSessionAccessContext`.
 */
const DIRECT_CALLERS: Record<string, string> = {
  "lib/auth-status.ts": "defines it (and the IMP-1 confinement it applies)",
  "lib/session-access.server.ts":
    "the sanctioned session path — it is what derives ImpersonatedBy from the session",
  "lib/api-auth/resolve-caller.server.ts":
    "bearer paths only; they pass the credential's bound org (MACHINE-1) and a bearer credential is never an impersonation. Its cookie branch goes through getSessionAccessContext",
  "lib/admin/user-target.server.ts":
    "resolves the TARGET user's context in the actor's org (bound-org path), not the caller's session",
  "lib/sso.server.ts":
    "resolves the launching principal by id; /api/sso/launch refuses an impersonated session outright before this is reached",
  "app/api/administrator/api-keys/route.ts":
    "resolves the credential OWNER's context for the on-behalf rank bound (MACHINE-2), not the caller's session",
  "app/api/v1/auth/token/route.ts":
    "mint path: resolves the principal against the credential's bound org, never a cookie",
};

/**
 * Account/self-service routes allowed to admit an impersonated session, and
 * WHY. Keep this list to surfaces that neither issue nor destroy credentials.
 */
const IMPERSONATION_OPT_INS: Record<string, string> = {
  "app/api/account/preferences/route.ts":
    "formatting preferences; issues no credential, and an admin reproducing a user's formatting problem needs it",
  "app/api/account/profile/route.ts": "ordinary profile fields; issues no credential",
  "app/api/preferences/locale/route.ts":
    "the shell's locale switcher posts here on every change, including inside an impersonated shell",
  "app/api/preferences/active-org/route.ts":
    "applies its OWN P0-1 refusal with a distinct forbidden_while_impersonating body; both paths refuse the same callers",
  "app/api/v1/me/route.ts":
    "read-only introspection of the identity the caller is already acting as",
  "app/api/v1/me/api-keys/route.ts":
    "GET only: the key list the account panel renders, CONFINED to the impersonated session's org (POST in the same file is refused by the default)",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Path below `src/`, with forward slashes, so the maps above read cleanly. */
function rel(full: string): string {
  return full.replace(/\\/g, "/").slice(SRC_DIR.replace(/\\/g, "/").length + 1);
}

/**
 * Both names are discussed at length in comments — in exactly the files that
 * correctly avoid them — so strip comments before scanning, or the guard would
 * punish the documentation it exists to encourage. (Same helper shape as
 * tests/unit/admin-route-scope-invariant.test.ts.)
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const sources = walk(SRC_DIR).map((full) => ({
  path: rel(full),
  code: readFileSync(full, "utf8"),
}));

describe("IMP-1: only the allow-listed modules resolve an access context directly", () => {
  const callers = sources
    .filter(({ code }) => /\bgetUserAccessContext\s*\(/.test(stripComments(code)))
    .map(({ path }) => path)
    .sort();

  it("discovers the callers at all (the scan is not silently matching nothing)", () => {
    expect(callers.length).toBeGreaterThan(3);
  });

  it("names only modules that still call it (no stale allowances)", () => {
    for (const key of Object.keys(DIRECT_CALLERS)) {
      expect(
        callers.includes(key),
        `DIRECT_CALLERS names ${key}, which no longer calls getUserAccessContext — drop the stale entry`,
      ).toBe(true);
    }
  });

  it.each(callers.map((p) => [p] as const))("%s is allow-listed with a reason", (path) => {
    const reason = DIRECT_CALLERS[path];
    expect(
      reason !== undefined && reason.length > 0,
      `${path} calls getUserAccessContext directly. A COOKIE SESSION caller cannot: ` +
        `the function takes a Better Auth user id and cannot tell whether that id is the ` +
        `person at the browser or an identity an admin has BORROWED, so it would resolve ` +
        `the active_org cookie against the TARGET's memberships and re-open the IMP-1 ` +
        `tenant pivot. Use getSessionAccessContext (@/lib/session-access.server), or add a ` +
        `justified entry to DIRECT_CALLERS if this genuinely resolves a non-session principal.`,
    ).toBe(true);
  });
});

describe("IMP-1: only the allow-listed routes admit an impersonated session", () => {
  const optIns = sources
    .filter(({ code }) => /allowImpersonation\s*:\s*true/.test(stripComments(code)))
    .map(({ path }) => path)
    .sort();

  it("names only routes that still opt in (no stale allowances)", () => {
    for (const key of Object.keys(IMPERSONATION_OPT_INS)) {
      expect(
        optIns.includes(key),
        `IMPERSONATION_OPT_INS names ${key}, which no longer opts in — drop the stale entry`,
      ).toBe(true);
    }
  });

  it.each(optIns.map((p) => [p] as const))("%s is allow-listed with a reason", (path) => {
    const reason = IMPERSONATION_OPT_INS[path];
    expect(
      reason !== undefined && reason.length > 0,
      `${path} passes allowImpersonation: true to the account guard. The self-service ` +
        `surface is closed to impersonated sessions by default because it MINTS, ROTATES ` +
        `and REVOKES credentials, and every ownership check passes while impersonating. ` +
        `Add a justified entry to IMPERSONATION_OPT_INS, or drop the option.`,
    ).toBe(true);
  });

  it("keeps the three credential-mutating routes on the default (refused)", () => {
    // The whole point of the default: these must NOT appear above, whatever
    // else is added to the list.
    const credentialMutations = [
      "app/api/v1/me/api-keys/[id]/route.ts",
      "app/api/v1/me/api-keys/[id]/rotate/route.ts",
    ];
    for (const path of credentialMutations) {
      const entry = sources.find((s) => s.path === path);
      expect(entry, `${path} no longer exists — update this invariant`).toBeDefined();
      expect(
        /allowImpersonation/.test(stripComments(entry!.code)),
        `${path} issues or destroys a credential and must stay on the guard's default refusal`,
      ).toBe(false);
    }
    // `me/api-keys/route.ts` holds BOTH the (opted-in) GET list and the mint
    // POST, so the file-level scan cannot speak for the POST; assert the mint
    // guard call itself carries no options bag.
    const mintFile = sources.find((s) => s.path === "app/api/v1/me/api-keys/route.ts");
    expect(mintFile).toBeDefined();
    expect(stripComments(mintFile!.code)).toContain(
      'requireApiAccount(request, "account.apikeys.manage");',
    );
  });
});
