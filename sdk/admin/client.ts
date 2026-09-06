/**
 * Hand-written entry point for the generated admin SDK (review #240).
 *
 * This file is listed in `.openapi-generator-ignore`, so `pnpm sdk:admin:generate`
 * never overwrites it. The generated `runtime.ts` bakes the deployment default
 * into `BASE_PATH`, sends no credentials unless told to, and exposes generic
 * `apiKey` / `username` / `password` knobs that no admin operation reads (the
 * generator ignores the spec's cookie scheme entirely). `createAdminClient`
 * builds the ONE `Configuration` shape the `/api/administrator` surface
 * actually wants, for each of the three ways a caller can authenticate:
 *
 *   - **Browser** (no `cookie`, no `bearerToken`): `credentials: "include"`
 *     so the Better Auth session cookie rides along; the browser sets
 *     `Origin` on mutations itself (`Origin` is a forbidden header name — a
 *     script cannot set it, so the SDK does not try).
 *   - **Server-side with a session** (`cookie`): forwards the `Cookie` header
 *     and adds `Origin: <origin>` because the CSRF guard requires it on every
 *     cookie-session mutation. The cookie value MUST be the signed value from
 *     a real browser session (the `__Secure-better-auth.session_token` cookie
 *     on https, `better-auth.session_token` on a plain-http dev origin).
 *   - **Bearer** (`bearerToken`): an API key (`drk_…`) or a JWT from
 *     `POST /api/v1/auth/token`; scope-bounded and exempt from the origin
 *     guard, so no `Origin` header is added. (This maps onto the generated
 *     `accessToken` knob — the only generated auth knob the admin surface
 *     uses; `apiKey`, `username` and `password` remain unused.)
 *
 * Usage:
 *
 *   import { createAdminClient } from "<path>/sdk/admin/client";
 *   import { UsersApi } from "<path>/sdk/admin";
 *
 *   const users = new UsersApi(createAdminClient({ origin: "https://app.example.com" }));
 *   const page = await users.listUsers({ page: 1, pageSize: 25 });
 */
import { Configuration, type ConfigurationParameters, type FetchAPI, type HTTPHeaders } from "./runtime";

/** Path the admin console API is mounted under on every deployment. */
export const ADMIN_API_PATH = "/api/administrator";

/** Better Auth's session cookie name — `__Secure-` prefixed on https (see review #196). */
export const SESSION_COOKIE_NAME_HTTPS = "__Secure-better-auth.session_token";
export const SESSION_COOKIE_NAME_HTTP = "better-auth.session_token";

export interface AdminClientOptions {
  /**
   * The deployment origin, e.g. `https://app.example.com` — scheme + host
   * (+ port), no path. `basePath` becomes `<origin>/api/administrator`.
   */
  origin: string;
  /**
   * Server-side callers only: the session to act as. Either a complete
   * `Cookie` header value (`__Secure-better-auth.session_token=…`) or just the
   * signed cookie VALUE, in which case the cookie name is derived from the
   * origin's scheme. Never a session id or a row from the `session` table.
   */
  cookie?: string;
  /** A DevResponse API key or access-token JWT (mutually exclusive with `cookie`). */
  bearerToken?: string;
  /** Extra headers sent on every request (e.g. `x-request-id`). */
  headers?: HTTPHeaders;
  /** Override the global `fetch` (tests, Node polyfills, instrumentation). */
  fetchApi?: FetchAPI;
}

/** `https://app.example.com` → `https://app.example.com/api/administrator`. */
export function adminBasePath(origin: string): string {
  return `${normalizeOrigin(origin)}${ADMIN_API_PATH}`;
}

/** The cookie name Better Auth uses for a deployment at `origin`. */
export function sessionCookieNameFor(origin: string): string {
  return new URL(normalizeOrigin(origin)).protocol === "https:"
    ? SESSION_COOKIE_NAME_HTTPS
    : SESSION_COOKIE_NAME_HTTP;
}

function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`createAdminClient: origin must be an absolute URL, got ${JSON.stringify(origin)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`createAdminClient: origin must be http(s), got ${url.protocol}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(
      `createAdminClient: origin must be scheme + host only (no path/query), got ${JSON.stringify(origin)}`,
    );
  }
  return url.origin;
}

/**
 * Builds the `Configuration` for one authentication mode (see the module
 * comment). Pass the result to any generated `…Api` class.
 */
export function createAdminClient(options: AdminClientOptions): Configuration {
  const origin = normalizeOrigin(options.origin);
  if (options.cookie !== undefined && options.bearerToken !== undefined) {
    throw new Error("createAdminClient: pass either cookie or bearerToken, not both");
  }
  const params: ConfigurationParameters = {
    basePath: `${origin}${ADMIN_API_PATH}`,
    ...(options.fetchApi ? { fetchApi: options.fetchApi } : {}),
  };
  const headers: HTTPHeaders = { ...(options.headers ?? {}) };

  if (options.bearerToken !== undefined) {
    if (options.bearerToken.length === 0) {
      throw new Error("createAdminClient: bearerToken must not be empty");
    }
    // The generated runtime turns `accessToken` into `Authorization: Bearer …`
    // on every operation (the spec's `bearerAuth` scheme). Bearer callers are
    // exempt from the origin guard, so no `Origin` header here.
    params.accessToken = options.bearerToken;
  } else if (options.cookie !== undefined) {
    if (options.cookie.length === 0) {
      throw new Error("createAdminClient: cookie must not be empty");
    }
    headers.Cookie = options.cookie.includes("=")
      ? options.cookie
      : `${sessionCookieNameFor(origin)}=${options.cookie}`;
    // Cookie-session mutations must carry a trusted Origin (CSRF guard); a
    // server-side caller has no browser to set it, so the SDK does.
    headers.Origin = origin;
  } else {
    // Browser: the session cookie is ambient — opt in to sending it. `Origin`
    // is set by the browser and cannot be set from script.
    params.credentials = "include";
  }

  if (Object.keys(headers).length > 0) params.headers = headers;
  return new Configuration(params);
}
