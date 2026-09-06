import { describe, expect, it, vi } from "vitest";
import { UsersApi } from "./index";
import {
  ADMIN_API_PATH,
  adminBasePath,
  createAdminClient,
  SESSION_COOKIE_NAME_HTTP,
  SESSION_COOKIE_NAME_HTTPS,
  sessionCookieNameFor,
  type AdminClientOptions,
} from "./client";

/**
 * The hand-written admin SDK entry point (review #240). The generated
 * `Configuration` sends nothing unless told to and bakes in a deployment
 * `BASE_PATH`; `createAdminClient` must produce, per credential mode, the
 * exact request shape the `/api/administrator` guard accepts. The requests
 * are captured through the GENERATED `UsersApi` with a stub fetch, so this
 * pins what actually goes on the wire — not just the config object.
 */
const ORIGIN = "https://app.example.com";
const EMPTY_PAGE = JSON.stringify({ items: [], page: 1, pageSize: 25, total: 0 });

/** Runs one `listUsers` through the generated client and returns the captured request. */
async function capture(options: AdminClientOptions) {
  const fetchApi = vi.fn(
    async () => new Response(EMPTY_PAGE, { headers: { "content-type": "application/json" } }),
  );
  const api = new UsersApi(createAdminClient({ ...options, fetchApi }));
  await api.listUsers({ page: 1 });
  const [url, init] = fetchApi.mock.calls[0] as unknown as [
    string,
    RequestInit & { credentials?: string },
  ];
  return { url, headers: new Headers(init.headers as HeadersInit), credentials: init.credentials };
}

describe("adminBasePath / sessionCookieNameFor", () => {
  it("mounts the console API under the origin and rejects anything but a bare origin", () => {
    expect(adminBasePath(ORIGIN)).toBe(`${ORIGIN}${ADMIN_API_PATH}`);
    expect(adminBasePath("https://app.example.com/")).toBe(`${ORIGIN}/api/administrator`);
    expect(() => adminBasePath("app.example.com")).toThrow(/absolute URL/);
    expect(() => adminBasePath("https://app.example.com/api")).toThrow(/scheme \+ host only/);
    expect(() => adminBasePath("ftp://app.example.com")).toThrow(/http\(s\)/);
  });

  it("derives Better Auth's cookie name from the scheme (__Secure- on https)", () => {
    expect(sessionCookieNameFor("https://app.example.com")).toBe(SESSION_COOKIE_NAME_HTTPS);
    expect(sessionCookieNameFor("http://localhost:3000")).toBe(SESSION_COOKIE_NAME_HTTP);
    expect(SESSION_COOKIE_NAME_HTTPS).toBe(`__Secure-${SESSION_COOKIE_NAME_HTTP}`);
  });
});

describe("createAdminClient", () => {
  it("browser mode: credentials include, no Origin header (the browser sets it), no auth knobs", async () => {
    const config = createAdminClient({ origin: ORIGIN });
    expect(config.basePath).toBe(`${ORIGIN}/api/administrator`);
    expect(config.credentials).toBe("include");
    expect(config.headers).toBeUndefined();
    expect(config.accessToken).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    const req = await capture({ origin: ORIGIN });
    expect(req.url).toBe(`${ORIGIN}/api/administrator/users?page=1`);
    expect(req.credentials).toBe("include");
    expect(req.headers.has("origin")).toBe(false);
    expect(req.headers.has("authorization")).toBe(false);
  });

  it("server mode with a cookie: forwards Cookie and adds Origin for the CSRF guard", async () => {
    const req = await capture({ origin: ORIGIN, cookie: "signed-value.sig" });
    // A bare value gets the https cookie name; the signed value is untouched.
    expect(req.headers.get("cookie")).toBe(`${SESSION_COOKIE_NAME_HTTPS}=signed-value.sig`);
    expect(req.headers.get("origin")).toBe(ORIGIN);
    expect(req.credentials).toBeUndefined();
    expect(req.headers.has("authorization")).toBe(false);
  });

  it("server mode accepts a full Cookie header and uses the plain name on an http dev origin", async () => {
    const full = await capture({
      origin: ORIGIN,
      cookie: "__Secure-better-auth.session_token=v.s; other=1",
    });
    expect(full.headers.get("cookie")).toBe("__Secure-better-auth.session_token=v.s; other=1");
    const dev = await capture({ origin: "http://localhost:3000", cookie: "v.s" });
    expect(dev.headers.get("cookie")).toBe(`${SESSION_COOKIE_NAME_HTTP}=v.s`);
    expect(dev.headers.get("origin")).toBe("http://localhost:3000");
  });

  it("bearer mode: Authorization header via the generated accessToken knob, no Origin (exempt)", async () => {
    const config = createAdminClient({ origin: ORIGIN, bearerToken: "drk_test_abc" });
    expect(config.headers).toBeUndefined();
    expect(config.accessToken).toBeTypeOf("function");
    const req = await capture({ origin: ORIGIN, bearerToken: "drk_test_abc" });
    expect(req.headers.get("authorization")).toBe("Bearer drk_test_abc");
    expect(req.headers.has("origin")).toBe(false);
    expect(req.headers.has("cookie")).toBe(false);
    expect(req.credentials).toBeUndefined();
  });

  it("extra headers ride along; cookie + bearer together and empty credentials are refused", async () => {
    const req = await capture({ origin: ORIGIN, cookie: "v", headers: { "x-request-id": "r-1" } });
    expect(req.headers.get("x-request-id")).toBe("r-1");
    expect(req.headers.get("origin")).toBe(ORIGIN);
    expect(() => createAdminClient({ origin: ORIGIN, cookie: "v", bearerToken: "t" })).toThrow(
      /either cookie or bearerToken/,
    );
    expect(() => createAdminClient({ origin: ORIGIN, cookie: "" })).toThrow(
      /cookie must not be empty/,
    );
    expect(() => createAdminClient({ origin: ORIGIN, bearerToken: "" })).toThrow(
      /bearerToken must not be empty/,
    );
  });
});
