import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-61 — systemic guard for privilege ordering (review #7) on the per-user
 * administrator routes, `/api/administrator/users/[id]/**`.
 *
 * A handler there that changes another user's account must refuse a target
 * who outranks the actor (`refuseOutrankingTarget`,
 * src/lib/admin/user-target.server.ts). No chokepoint runs it for them: each
 * handler calls it right after `resolveTargetUser`, and `PATCH /users/[id]`
 * shipped without it while every sibling had it, so an org admin could rename
 * a superadmin who shared their org. This scan fails CI when a mutating
 * handler has neither the rank guard nor a reviewed exemption below, and an
 * exemption must name the guard that stands in for it (checked, not trusted).
 *
 * It also pins the AUTHZ-2 shared-target rule on the handlers whose effect is
 * account-global. The single-session revoke had the rank guard but not this
 * rule, which revoke-all had (F-60). That list is a declaration, not a
 * derivation: a NEW account-global handler has to be added to it by hand.
 *
 * And it pins the F-77 refusal: a handler that calls a Better Auth wrapper
 * acting on the target's Better Auth user first refuses an agent service
 * account, which has none.
 *
 * Granularity is the exported handler (`export const <METHOD> =` or `export
 * [async] function <METHOD>`, up to the next export), so a guard in one method
 * does not cover its sibling. It reads source text: the route tests
 * (tests/integration/administrator-user-actions.test.ts) are what prove each
 * guard runs before the side effect.
 */

const USER_ROUTES_DIR = fileURLToPath(
  new URL("../../src/app/api/administrator/users/[id]", import.meta.url),
);

const RANK_GUARD = /\brefuseOutrankingTarget\s*\(/;
const SHARED_TARGET_RULE = /\brequiresSuperadminForSharedTarget\s*\(/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mutating handlers that take no rank guard, each with the guard that makes it
 * unnecessary. Adding one should be a reviewed decision, not a way to pass.
 */
const EXEMPT: Record<string, { guard: RegExp; why: string }> = {
  "app-roles/route.ts POST": {
    guard: /\bunheldPermissionKeys\s*\(/,
    why: "AUTHZ-3: assigns only a role whose permissions the actor could confer",
  },
  "app-roles/route.ts DELETE": {
    guard: /\bunheldPermissionKeys\s*\(/,
    why: "REVOKE-1: revokes only a role whose permissions the actor could confer",
  },
  "groups/route.ts POST": {
    guard: /\bunheldPermissionKeys\s*\(/,
    why: "AUTHZ-3: adds the user only to a group whose roles the actor could confer",
  },
  "groups/route.ts DELETE": {
    guard: /\bunheldPermissionKeys\s*\(/,
    why: "REVOKE-1: removes the user only from a group whose roles the actor could confer",
  },
  "memberships/route.ts POST": {
    guard: /\bcanAccessOrg\s*\(/,
    why: "adds a membership only in an org the actor administers; it removes nothing and writes nothing account-global",
  },
  "role/route.ts POST": {
    guard: /\bhasCrossOrgReach\s*\(/,
    why: "cross-org reach only (an unbound superadmin), whom the rank guard exempts anyway",
  },
  "impersonate/route.ts POST": {
    guard: /"privilege_escalation"/,
    why: "its own escalation guard: the same subset test, in the actor's org and in every org the two share",
  },
  "impersonate/route.ts DELETE": {
    guard: /\bgetImpersonatorId\s*\(/,
    why: "stops the caller's own impersonation; the `[id]` segment is ignored and no target is resolved",
  },
};

/**
 * Handlers whose effect reaches the target in every org they belong to, so a
 * non-superadmin may not apply them to a user shared with other orgs (AUTHZ-2).
 */
const ACCOUNT_GLOBAL: Record<string, string> = {
  "route.ts PATCH": "F-61: the display name (mirrored to Better Auth) and the preferred locale",
  "route.ts DELETE": "soft-delete: a Better Auth ban plus the membership cascade",
  "ban/route.ts POST": "a Better Auth ban",
  "unban/route.ts POST": "a Better Auth unban",
  "password/route.ts POST": "a password usable in every org (mode `set`)",
  "restore/route.ts POST": "restore: a Better Auth unban plus the membership restore",
  "sessions/route.ts DELETE": "revoke-all: sessions are not tied to an org",
  "sessions/[sessionId]/route.ts DELETE": "F-60: one session is as account-global as all of them",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

interface Handler {
  where: string;
  method: string;
  body: string;
}

/** Split a route file into its exported HTTP-method handlers. */
function handlersOf(rel: string, source: string): Handler[] {
  const exportRe =
    /^export\s+(?:(?:async\s+)?function\s+(\w+)|const\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b)/gm;
  const starts = [...source.matchAll(exportRe)].map((m) => ({
    method: (m[1] ?? m[2])!,
    at: m.index!,
  }));
  return starts.map((s, i) => ({
    where: `${rel} ${s.method}`,
    method: s.method,
    body: source.slice(s.at, starts[i + 1]?.at ?? source.length),
  }));
}

const handlers = walk(USER_ROUTES_DIR).flatMap((file) => {
  const rel = relative(USER_ROUTES_DIR, file).split(sep).join("/");
  return handlersOf(rel, readFileSync(file, "utf8"));
});
const mutating = handlers.filter((h) => MUTATING.has(h.method));
const byWhere = new Map(handlers.map((h) => [h.where, h]));

describe("per-user target guards (review #7, AUTHZ-2; F-60, F-61)", () => {
  it("splits a file per handler, so a guard in one method does not cover the next", () => {
    const split = handlersOf(
      "x/route.ts",
      [
        `export const dynamic = "force-dynamic";`,
        `export const GET = withAdminRoute(async function GET() { refuseOutrankingTarget(g, t, r, "a"); });`,
        `export const PATCH = withAdminRoute(async function PATCH() { resolveTargetUser(id, a); });`,
        `export async function DELETE() { refuseOutrankingTarget(g, t, r, "b"); }`,
      ].join("\n"),
    );
    expect(split.map((h) => h.where)).toEqual([
      "x/route.ts GET",
      "x/route.ts PATCH",
      "x/route.ts DELETE",
    ]);
    expect(split.map((h) => RANK_GUARD.test(h.body))).toEqual([true, false, true]);
  });

  it("finds the mutating handlers (the scan is not vacuous)", () => {
    expect(mutating.map((h) => h.where)).toEqual(
      expect.arrayContaining([
        "route.ts PATCH",
        "route.ts DELETE",
        "status/route.ts POST",
        "sessions/[sessionId]/route.ts DELETE",
      ]),
    );
  });

  it("every mutating handler runs the rank guard, or the reviewed guard that stands in for it", () => {
    const offenders = mutating
      .filter((h) => !RANK_GUARD.test(h.body))
      .flatMap((h) => {
        const exempt = EXEMPT[h.where];
        if (!exempt) return [`${h.where}: missing refuseOutrankingTarget(...)`];
        return exempt.guard.test(h.body)
          ? []
          : [`${h.where}: exempt for "${exempt.why}", but ${exempt.guard} is gone`];
      });
    expect(
      offenders,
      "call refuseOutrankingTarget right after resolveTargetUser (see DELETE /users/[id])",
    ).toEqual([]);
  });

  it("every exemption names a mutating handler that still lacks the rank guard", () => {
    const stale = Object.keys(EXEMPT).filter((where) => {
      const h = byWhere.get(where);
      return !h || !MUTATING.has(h.method) || RANK_GUARD.test(h.body);
    });
    expect(stale, "drop the exemption: the handler is gone or now runs the guard").toEqual([]);
  });

  // F-77: an MCP agent's service account has no Better Auth user, so every
  // wrapper below finds none and the handler answered 502 (or, for the reset
  // email, reported a message sent that nobody can receive). A handler that
  // calls one must ask `isAgentServiceAccount` first. Derived, not declared: a
  // new handler that calls a wrapper is held to it without being listed.
  it("every handler that works on the Better Auth user first asks isAgentServiceAccount (F-77)", () => {
    const LOGIN_ACCOUNT_CALL =
      /\b(?:banBetterAuthUser|unbanBetterAuthUser|restoreBetterAuthBan|banForSoftDelete|setBetterAuthUserPassword|sendBetterAuthPasswordResetEmail|setBetterAuthUserRole|impersonateBetterAuthUser|updateBetterAuthUser)\s*\(/;
    const callers = mutating.filter((h) => LOGIN_ACCOUNT_CALL.test(h.body));
    expect(callers.map((h) => h.where)).toEqual(
      expect.arrayContaining([
        "ban/route.ts POST",
        "unban/route.ts POST",
        "route.ts DELETE",
        "route.ts PATCH",
        "restore/route.ts POST",
        "password/route.ts POST",
        "role/route.ts POST",
        "impersonate/route.ts POST",
      ]),
    );
    const offenders = callers
      .filter((h) => !/\bisAgentServiceAccount\s*\(/.test(h.body))
      .map((h) => h.where);
    expect(
      offenders,
      "refuse an agent service account with 409 not_applicable_to_service_account (see POST …/ban)",
    ).toEqual([]);
  });

  it("every account-global handler applies the AUTHZ-2 shared-target rule", () => {
    const offenders = Object.entries(ACCOUNT_GLOBAL)
      .filter(([where]) => !SHARED_TARGET_RULE.test(byWhere.get(where)?.body ?? ""))
      .map(([where, what]) => `${where} (${what})`);
    expect(
      offenders,
      "refuse a shared target with requiresSuperadminForSharedTarget (see DELETE …/sessions)",
    ).toEqual([]);
  });
});
