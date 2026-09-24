import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_DISABLED_PATHS,
  IMPERSONATION_ALLOWED_PATHS,
  isAdminPluginPath,
} from "@/lib/auth-admin-surface";
import { setSignupProvisioningSuppressed } from "@/lib/auth-signup-provisioning";
import { stripQuery } from "@/lib/observability/sentry-shared";
import type { auth as AuthInstance } from "@/lib/auth";
import type * as NextJsIntegration from "better-auth/next-js";

/**
 * F-06 — EVERY endpoint Better Auth mounts on `/api/auth/[...all]` is
 * classified, and the classification is what the REAL `auth` instance does.
 *
 * IMP-3 once closed five named endpoints to an impersonated session and left
 * every endpoint it did not name open: `/list-accounts` + `/get-access-token`
 * handed an impersonator the target's provider tokens, `/unlink-account`
 * stripped a login, `/verify-password` answered password guesses. A list of
 * names goes stale with every Better Auth upgrade. So this suite enumerates the
 * endpoints from the live instance built by src/lib/auth.ts (its plugins, its
 * `disabledPaths`, its `hooks.before`) and fails when one is unclassified:
 *
 *   - admin plugin (`/admin/*`) — 404 over HTTP (review 2026-09-04 #3);
 *   - {@link AUTH_DISABLED_PATHS} — 404 for everyone (`disabledPaths`);
 *   - {@link IMPERSONATION_ALLOWED_PATHS} — open, even while impersonating;
 *   - {@link OPEN_ENDPOINTS} below — open to the session's own owner and
 *     refused (403) while impersonating.
 *
 * A Better Auth upgrade that adds an endpoint therefore fails here until
 * someone decides which list it belongs on, and one that removes or renames an
 * endpoint fails the stale-entry check, so a typo in `disabledPaths` cannot
 * silently disable nothing.
 *
 * BEHAVIORAL: the real instance runs on Better Auth's memory adapter instead of
 * the pg pool (the same technique as signup-policy-organization-hint.test.ts)
 * and is driven through `auth.handler`, the function the Next catch-all mounts.
 */

/**
 * Endpoints that stay reachable for the session's OWN owner, each with the UI
 * or flow that needs it. Adding an entry is a reviewed decision: it is still
 * refused to an impersonated session, but it is open to everyone else.
 */
const OPEN_ENDPOINTS: Record<string, string> = {
  "/sign-in/email": "the email/password sign-in form",
  "/sign-up/email": "the sign-up form",
  "/sign-in/social": "the social sign-in buttons",
  "/callback/:id": "the OAuth redirect URI registered with every provider",
  "/request-password-reset": "the forgot-password form",
  "/reset-password/:token": "the link in the password-reset email",
  "/reset-password": "the reset-password form",
  "/send-verification-email": "the resend-verification form",
  "/verify-email": "the link in the verification email",
  "/change-password": "account security: the password form",
  "/list-sessions": "account security: the sessions panel",
  "/revoke-session": "account security: revoke one session",
  "/revoke-other-sessions": "account security: revoke every other session",
  "/ok": "a sessionless liveness probe that exposes nothing",
  "/error": "Better Auth's OAuth error page (no errorCallbackURL is configured)",
};

const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/email/send.server", () => ({ sendAppEmail: vi.fn() }));
vi.mock("@/lib/auth-login-audit.server", () => ({ recordSessionLogin: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));
// Needs a Next.js request scope. It mounts no endpoint (pinned below against
// the real plugin), so stubbing it hides nothing from the classification.
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));

// Every seeded user already has an `app_users` row, so the session hook's
// provisioning branch never runs.
vi.mock("@/db/database", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: () => Promise.resolve({ id: "app-user", status: "active" }),
  };
  return {
    pgPool: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    db: { selectFrom: () => chain },
  };
});

const BASE_URL = "http://localhost:3000";
const PASSWORD = "ci-only-endpoint-classification-password";

type Auth = typeof AuthInstance;

interface MountedEndpoint {
  key: string;
  path: string;
  method: string;
}

interface EndpointShape {
  path?: string;
  options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
}

let auth: Auth;

beforeAll(async () => {
  ({ auth } = await import("@/lib/auth"));
});

beforeEach(() => auditMock.mockReset());

/** Every endpoint better-call's router mounts (it skips `SERVER_ONLY`). */
function mountedEndpoints(): MountedEndpoint[] {
  return Object.entries(auth.api as unknown as Record<string, EndpointShape>).flatMap(
    ([key, endpoint]) => {
      if (!endpoint.path || !endpoint.options || endpoint.options.metadata?.SERVER_ONLY) {
        return [];
      }
      const method = endpoint.options.method;
      return [{ key, path: endpoint.path, method: Array.isArray(method) ? method[0]! : method! }];
    },
  );
}

function serverOnlyEndpoints(): string[] {
  return Object.entries(auth.api as unknown as Record<string, EndpointShape>)
    .filter(([, endpoint]) => endpoint.options?.metadata?.SERVER_ONLY)
    .map(([key]) => key)
    .sort();
}

/** A concrete URL for a route pattern (`/callback/:id` → `/callback/x`). */
function concrete(path: string): string {
  return path.replace(/:[^/]+/g, "x");
}

function cookieHeaderFrom(headers: Headers): string {
  const jar = new Map<string, string>();
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    const value = pair.slice(eq + 1);
    if (value) jar.set(pair.slice(0, eq), value);
    else jar.delete(pair.slice(0, eq));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Calls an endpoint over HTTP with an empty body — the hook runs before validation. */
function call(endpoint: { path: string; method: string }, cookie?: string): Promise<Response> {
  const url = `${BASE_URL}/api/auth${concrete(endpoint.path)}`;
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (endpoint.method === "GET") {
    return auth.handler(new Request(url, { method: "GET", headers }));
  }
  return auth.handler(
    new Request(url, {
      method: endpoint.method,
      headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
      body: "{}",
    }),
  );
}

async function seedUser(email: string, role: "admin" | "user"): Promise<string> {
  const ctx = await auth.$context;
  // The seed path: the sign-up provisioning hook stands down, exactly as it
  // does for `pnpm db:seed`, so no org policy lookup is needed.
  setSignupProvisioningSuppressed(true);
  try {
    const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    await ctx.internalAdapter.updateUser(res.user.id, { role, emailVerified: true });
    return res.user.id;
  } finally {
    setSignupProvisioningSuppressed(false);
  }
}

async function signIn(email: string): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  return cookieHeaderFrom(res.headers);
}

let seq = 0;
/** A fresh admin + member pair and an impersonated session for the member. */
async function borrowedSession(): Promise<{ adminId: string; memberId: string; cookie: string }> {
  seq += 1;
  const adminEmail = `classify-admin-${seq}@example.com`;
  const adminId = await seedUser(adminEmail, "admin");
  const memberId = await seedUser(`classify-member-${seq}@example.com`, "user");
  const adminCookie = await signIn(adminEmail);
  const started = await auth.api.impersonateUser({
    body: { userId: memberId },
    headers: new Headers({ cookie: adminCookie }),
    returnHeaders: true,
  });
  expect(started.response.user.id).toBe(memberId);
  return { adminId, memberId, cookie: cookieHeaderFrom(started.headers) };
}

describe("F-06: every Better Auth endpoint on the real instance is classified", () => {
  it("leaves no mounted endpoint unclassified", () => {
    const unclassified = mountedEndpoints()
      .map((endpoint) => endpoint.path)
      .filter(
        (path) =>
          !isAdminPluginPath(path) &&
          !AUTH_DISABLED_PATHS.includes(path) &&
          !IMPERSONATION_ALLOWED_PATHS.includes(path) &&
          !(path in OPEN_ENDPOINTS),
      );
    expect(
      unclassified,
      `Unclassified Better Auth endpoint(s): ${unclassified.join(", ")}. Add each to ` +
        "AUTH_DISABLED_PATHS (src/lib/auth-admin-surface.ts) if the app never calls it over " +
        "HTTP, or to OPEN_ENDPOINTS here with the UI or flow that needs it.",
    ).toEqual([]);
  });

  it("names no endpoint that is not mounted (a stale or misspelled entry disables nothing)", () => {
    const mounted = new Set(mountedEndpoints().map((endpoint) => endpoint.path));
    const classified = [
      ...AUTH_DISABLED_PATHS,
      ...IMPERSONATION_ALLOWED_PATHS,
      ...Object.keys(OPEN_ENDPOINTS),
    ];
    expect(classified.filter((path) => !mounted.has(path))).toEqual([]);
  });

  it("puts every endpoint on exactly one list", () => {
    const lists = [AUTH_DISABLED_PATHS, IMPERSONATION_ALLOWED_PATHS, Object.keys(OPEN_ENDPOINTS)];
    const all = lists.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((path) => isAdminPluginPath(path))).toEqual([]);
  });

  it("enumerates the real plugin set (admin endpoints present, nothing hidden by the stub)", async () => {
    const paths = mountedEndpoints().map((endpoint) => endpoint.path);
    expect(paths).toContain("/admin/impersonate-user");
    expect(paths).toContain("/get-access-token");
    // The only stubbed plugin mounts no endpoint of its own. Read at runtime,
    // not from its type: a release that adds one must fail here.
    const actual = await vi.importActual<typeof NextJsIntegration>("better-auth/next-js");
    const plugin = actual.nextCookies() as { endpoints?: Record<string, unknown> };
    expect(Object.keys(plugin.endpoints ?? {})).toEqual([]);
  });

  it("keeps the server-only endpoints unmounted", async () => {
    // `SERVER_ONLY` endpoints are callable only as `auth.api.*`; the router
    // never mounts them, which is why they need no classification above.
    expect(serverOnlyEndpoints()).toEqual(["createSsoSession", "setPassword"]);
    const res = await call({ path: "/sso-session/create", method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("F-06: the real instance closes the unused vendor surface for everyone", () => {
  it("passes AUTH_DISABLED_PATHS to Better Auth as disabledPaths", async () => {
    const ctx = await auth.$context;
    expect(ctx.options.disabledPaths).toEqual([...AUTH_DISABLED_PATHS]);
  });

  it("404s every disabled endpoint for the session's own owner, and runs no handler", async () => {
    seq += 1;
    const email = `classify-owner-${seq}@example.com`;
    await seedUser(email, "user");
    const cookie = await signIn(email);
    const disabled = mountedEndpoints().filter((endpoint) =>
      AUTH_DISABLED_PATHS.includes(endpoint.path),
    );
    expect(disabled).toHaveLength(AUTH_DISABLED_PATHS.length);

    for (const endpoint of disabled) {
      const res = await call(endpoint, cookie);
      expect(res.status, endpoint.path).toBe(404);
    }
    // `/revoke-sessions` would have ended the caller's own session.
    const me = await call({ path: "/get-session", method: "GET" }, cookie);
    expect(((await me.json()) as { user: { email: string } } | null)?.user.email).toBe(email);
  });

  it("still serves the owner every open endpoint (no 403, no 404 from our policies)", async () => {
    seq += 1;
    const email = `classify-open-${seq}@example.com`;
    await seedUser(email, "user");
    const open = mountedEndpoints().filter(
      (endpoint) =>
        endpoint.path in OPEN_ENDPOINTS || IMPERSONATION_ALLOWED_PATHS.includes(endpoint.path),
    );

    for (const endpoint of open) {
      // A fresh session per call: `/sign-out` ends the one it is given.
      const res = await call(endpoint, await signIn(email));
      expect([403, 404], `${endpoint.path} → ${res.status}`).not.toContain(res.status);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("F-06: an impersonated session on the real instance reaches only the allow-list", () => {
  it("403s every open endpoint outside the allow-list and audits each against the impersonator", async () => {
    const { adminId, memberId, cookie } = await borrowedSession();
    const refused = mountedEndpoints().filter((endpoint) => endpoint.path in OPEN_ENDPOINTS);
    expect(refused.length).toBe(Object.keys(OPEN_ENDPOINTS).length);

    for (const endpoint of refused) {
      const res = await call(endpoint, cookie);
      expect(res.status, endpoint.path).toBe(403);
    }

    expect(auditMock).toHaveBeenCalledTimes(refused.length);
    for (const endpoint of refused) {
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "account.impersonated_access.denied",
          actorBetterAuthUserId: adminId,
          metadata: expect.objectContaining({
            impersonatedBetterAuthUserId: memberId,
            path: endpoint.path,
            surface: "better-auth",
          }),
        }),
      );
    }
  });

  it("404s the disabled endpoints and the admin plugin for it too", async () => {
    const { cookie } = await borrowedSession();
    for (const endpoint of mountedEndpoints()) {
      if (!AUTH_DISABLED_PATHS.includes(endpoint.path) && !isAdminPluginPath(endpoint.path)) {
        continue;
      }
      const res = await call(endpoint, cookie);
      expect(res.status, endpoint.path).toBe(404);
    }
  });

  it("serves /get-session as the borrowed user and lets /sign-out end it", async () => {
    const { memberId, cookie } = await borrowedSession();

    const me = await call({ path: "/get-session", method: "GET" }, cookie);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(memberId);

    expect((await call({ path: "/sign-out", method: "POST" }, cookie)).status).toBe(200);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

/**
 * F-23: a route parameter is part of the path Sentry records
 * (`contexts.nextjs.request_path`, `request.url`, span names), and the
 * scrubber redacts path segments by route (`RESET_PATH_TOKEN_RE` in
 * src/lib/observability/sentry-shared.ts), not by shape. So every mounted
 * route with a parameter is listed with what the parameter holds, and a
 * Better Auth release that adds one fails here until someone decides whether
 * it needs a redaction rule.
 */
const PATH_PARAMETERS: Record<string, string> = {
  "/callback/:id": "the provider id (`google`, `github`): not a secret",
  "/reset-password/:token": "the one-time reset token: stripQuery redacts it",
};

describe("F-23: every parameterised Better Auth route has a Sentry disposition", () => {
  it("lists every mounted route with a path parameter", () => {
    const parameterised = new Set(
      mountedEndpoints()
        .map((endpoint) => endpoint.path)
        .filter((path) => path.includes("/:")),
    );
    expect([...parameterised].sort()).toEqual(Object.keys(PATH_PARAMETERS).sort());
  });

  it("strips each one as the catch-all route receives it", () => {
    expect(stripQuery("/api/auth/reset-password/Qx9ResetToken?callbackURL=%2Fen")).toBe(
      "/api/auth/reset-password/[redacted-token]",
    );
    expect(stripQuery("https://app/api/auth/callback/google?code=abc&state=def")).toBe(
      "https://app/api/auth/callback/google",
    );
  });
});
