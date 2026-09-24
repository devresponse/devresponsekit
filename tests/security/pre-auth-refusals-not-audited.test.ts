import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as InMemoryLimiter from "@/lib/admin/rate-limit.server";
import type * as MetricsModule from "@/lib/observability/metrics.server";

/**
 * F-15 — A REFUSAL DECIDED BEFORE THE CALLER IS AUTHENTICATED WRITES NO AUDIT ROW.
 *
 * `app_audit_events` is append-only and trigger-protected. The admin CSRF
 * origin guard wrote one row per refused request before anything about the
 * caller was known, so `while true; do curl -X POST …/api/administrator/users
 * -H 'User-Agent: <8 KB>'; done` from many IPs grew the table without bound.
 * `/api/sso/consume` (garbage token, no token, cross-site confirm) and the
 * signed-out `/api/sso/launch` did the same behind a per-IP limiter that still
 * admitted ~86k rows a day per IP.
 *
 * The rule now: a row needs something VERIFIED — a session, a credential, a
 * signed handoff token. Anything refused before that is a `logPreAuthRefusal`
 * log line + counter. This suite pins it two ways:
 *
 *   1. a SOURCE SCAN of every `checkTrustedOrigin` call site in `src/`: each
 *      refusal branch must log and must not audit — so the next surface that
 *      adds an origin check inherits the rule or fails here;
 *   2. the REAL guards and routes (admin pipeline, account guard, impersonation
 *      stop, invitation accept, both SSO endpoints) over the REAL `auditEvent`
 *      and a database stub that records every insert: the pre-auth refusals insert nothing
 *      and are counted, while an AUTHENTICATED denial still writes its row —
 *      with the User-Agent capped, which is the other half of the fix.
 */

// ---------------------------------------------------------------------------
// 1. Source scan
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The `{ … }` body starting at `open` (which must index a `{`), braces balanced. */
function blockAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

/** Every `if (!x.ok) { … }` refusal branch that follows a `checkTrustedOrigin(` call. */
function originRefusalBranches(): { file: string; block: string }[] {
  const found: { file: string; block: string }[] = [];
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, "utf8");
    const calls = [...source.matchAll(/(?<!function )checkTrustedOrigin\(/g)];
    for (const call of calls) {
      const branch = /if\s*\(\s*!\s*\w+\.ok\s*\)\s*\{/g;
      branch.lastIndex = call.index;
      const match = branch.exec(source);
      if (!match) throw new Error(`no refusal branch after checkTrustedOrigin in ${path}`);
      const open = match.index + match[0].length - 1;
      found.push({
        file: relative(process.cwd(), path).replaceAll("\\", "/"),
        block: blockAt(source, open),
      });
    }
  }
  return found;
}

describe("every origin-guard refusal is logged, never audited (source scan)", () => {
  const branches = originRefusalBranches();

  it("finds every known call site (the scan cannot pass by matching nothing)", () => {
    const files = new Set(branches.map((b) => b.file));
    for (const expected of [
      "src/lib/admin/permissions.server.ts",
      "src/lib/api-auth/v1-guard.server.ts",
      "src/lib/account/guard.server.ts",
      "src/app/api/sso/consume/route.ts",
      "src/app/api/invitations/accept/route.ts",
      "src/app/api/administrator/users/[id]/impersonate/route.ts",
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it.each(originRefusalBranches().map((b) => [b.file, b.block] as const))(
    "%s: the refusal branch calls logPreAuthRefusal and writes no audit row",
    (_file, block) => {
      expect(block).toContain("logPreAuthRefusal(");
      expect(block).not.toMatch(/\baudit[A-Z]\w*\(|\bauditEvent\(|insertInto\(/);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Behaviour over the real audit writer
// ---------------------------------------------------------------------------

/** Every row `auditEvent` inserted — the thing an attacker must not control. */
const auditRows = vi.hoisted(() => [] as Record<string, unknown>[]);

const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/db/database", () => ({
  db: {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === "app_audit_events") auditRows.push(values);
        return { execute: async () => undefined };
      },
    }),
  },
}));
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  getImpersonatorId: () => null,
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
// Neither is reached on a refusal; stubbed so the routes' module graphs load
// without a Better Auth instance or a nonce table.
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/sso.server", () => ({
  consumeSsoHandoffNonce: vi.fn(),
  createSsoHandoffRedirect: vi.fn(),
}));
// Both SSO endpoints limit a pre-auth caller per IP from the SHARED Postgres
// bucket (F-19). The stub database above has no query executor, so the real
// primitive would fall back to memory with a warning; route it to the in-memory
// helper directly, resolved per call so each test's fresh module graph is used.
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  enforceSharedRateLimit: async (...a: Parameters<typeof InMemoryLimiter.enforceRateLimit>) =>
    (await import("@/lib/admin/rate-limit.server")).enforceRateLimit(...a),
}));

const penv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = penv.NODE_ENV;
const HUGE_UA = `curl/8.0 ${"A".repeat(8 * 1024)}`;

function makeRequest(url: string, method: string, headers: Record<string, string> = {}) {
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "user-agent": HUGE_UA, ...headers }),
    formData: async () => new FormData(),
  } as unknown as NextRequest;
}

let metrics: typeof MetricsModule;

async function refusals(eventType: string): Promise<number> {
  const { values } = await metrics.preAuthRefusalsTotal.get();
  return values.find((v) => v.labels.event_type === eventType)?.value ?? 0;
}

beforeEach(async () => {
  auditRows.length = 0;
  sessionGetter.mockReset().mockResolvedValue(null);
  accessGetter.mockReset();
  metrics = await import("@/lib/observability/metrics.server");
});
afterEach(() => {
  // The origin guard short-circuits under NODE_ENV=test; the cross-site cases
  // run the REAL matcher by leaving it for the call and restoring it here.
  penv.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.resetModules();
});

describe("pre-authentication refusals write no audit row (real auditEvent)", () => {
  it("the admin pipeline: a cross-site cookie POST is 403 untrusted_origin, counted, and inserts nothing", async () => {
    const { requireAdminPermission, isAdminPermissionDenial } =
      await import("@/lib/admin/permissions.server");
    penv.NODE_ENV = "development";
    // The finding's loop, 25 times over.
    for (let i = 0; i < 25; i += 1) {
      const result = await requireAdminPermission(
        makeRequest("http://localhost:3000/api/administrator/users", "POST", {
          origin: "https://evil.example",
        }),
        "admin.users.manage",
      );
      expect(isAdminPermissionDenial(result)).toBe(true);
      if (isAdminPermissionDenial(result)) {
        expect(result.response.status).toBe(403);
        expect(((await result.response.json()) as { error: string }).error).toBe(
          "untrusted_origin",
        );
      }
    }
    expect(auditRows).toEqual([]);
    expect(await refusals("administrator.access.denied")).toBe(25);
    expect(sessionGetter).not.toHaveBeenCalled();
  });

  it("the account guard: a cross-site cookie POST is refused, counted, and inserts nothing", async () => {
    const { requireAccountUser } = await import("@/lib/account/guard.server");
    penv.NODE_ENV = "development";
    const result = await requireAccountUser(
      makeRequest("http://localhost:3000/api/account/profile", "PATCH", {
        origin: "https://evil.example",
      }),
      "account.profile.write",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(auditRows).toEqual([]);
    expect(await refusals("account.access.denied")).toBe(1);
  });

  it("impersonation stop: a cross-site DELETE is 403 untrusted_origin, counted, and inserts nothing", async () => {
    const { DELETE } = await import("@/app/api/administrator/users/[id]/impersonate/route");
    penv.NODE_ENV = "development";
    const res = await DELETE(
      makeRequest("http://localhost:3000/api/administrator/users/u-1/impersonate", "DELETE", {
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("untrusted_origin");
    expect(auditRows).toEqual([]);
    expect(await refusals("administrator.access.denied")).toBe(1);
    expect(sessionGetter).not.toHaveBeenCalled();
  });

  it("invitation accept: a cross-site POST is 403 untrusted_origin, counted, and inserts nothing", async () => {
    const { POST } = await import("@/app/api/invitations/accept/route");
    penv.NODE_ENV = "development";
    const res = await POST(
      makeRequest("http://localhost:3000/api/invitations/accept", "POST", {
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("untrusted_origin");
    expect(auditRows).toEqual([]);
    expect(await refusals("invitation.access.denied")).toBe(1);
    expect(sessionGetter).not.toHaveBeenCalled();
  });

  it("SSO consume: a garbage token, a missing token and a cross-site confirm insert nothing", async () => {
    const { GET, POST } = await import("@/app/api/sso/consume/route");
    // The REAL verifier (self-issuer test keys): random bytes never verify.
    const garbage = await GET(
      makeRequest("http://localhost:3000/api/sso/consume?token=not.a.jwt", "GET"),
    );
    expect(garbage.status).toBe(401);
    const missing = await GET(makeRequest("http://localhost:3000/api/sso/consume", "GET"));
    expect(missing.status).toBe(400);
    const emptyPost = await POST(makeRequest("http://localhost:3000/api/sso/consume", "POST"));
    expect(emptyPost.status).toBe(400);

    penv.NODE_ENV = "development";
    const crossSite = await POST(
      makeRequest("http://localhost:3000/api/sso/consume", "POST", {
        origin: "https://evil.example",
      }),
    );
    expect(crossSite.status).toBe(403);

    expect(auditRows).toEqual([]);
    expect(await refusals("sso.consume.failure")).toBe(4);
  });

  it("SSO launch: a signed-out launch redirects to sign-in, counted, and inserts nothing", async () => {
    const { GET } = await import("@/app/api/sso/launch/route");
    const res = await GET(
      makeRequest("http://localhost:3000/api/sso/launch?applicationId=portal&locale=en", "GET"),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/en/sign-in");
    expect(auditRows).toEqual([]);
    expect(await refusals("sso.launch.failure")).toBe(1);
  });
});

describe("authenticated denials stay audited — with the User-Agent capped", () => {
  it("a signed-in caller without the permission still writes administrator.access.denied, UA ≤ 512", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-member" }, session: { id: "s-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-member",
      primaryEmail: "member@example.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view"],
    });
    const { requireAdminPermission, isAdminPermissionDenial } =
      await import("@/lib/admin/permissions.server");
    const result = await requireAdminPermission(
      makeRequest("http://localhost:3000/api/administrator/users", "GET"),
      "admin.users.read",
    );
    expect(isAdminPermissionDenial(result)).toBe(true);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      event_type: "administrator.access.denied",
      outcome: "denied",
      actor_better_auth_user_id: "ba-member",
      reason: "missing_admin_permission",
    });
    // F-15: the row is permanent, so the client-chosen header is bounded even
    // for a caller who got past authentication.
    expect(auditRows[0]!.user_agent).toBe(HUGE_UA.slice(0, 512));
    expect(await refusals("administrator.access.denied")).toBe(0);
  });
});
