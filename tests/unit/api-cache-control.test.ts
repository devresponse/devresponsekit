import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { NextConfig } from "next";
import type * as NextTesting from "next/experimental/testing/server";

/**
 * I-07 (review #116): every `/api` response carries `Cache-Control: private,
 * no-store`, set once in `next.config.mjs` `headers()`, except on the routes
 * that publish their own cacheable policy.
 *
 * The exception is the part that can silently break. On a self-hosted `next
 * start` a config header is written before the route runs and Next then skips
 * the route's header of the same name, so a route whose `max-age` the config
 * pattern still matched would lose it (the e2e JWKS check would catch the key
 * sets, nothing would catch a new one). The scan below derives which routes
 * cache from the route files themselves, so both directions are pinned: a
 * self-cached route the pattern covers, and a route the pattern leaves without
 * `no-store`.
 *
 * The matching is Next's own: `unstable_getResponseFromNextConfig` runs the
 * config's header rules through the same `buildCustomRoute` the server uses.
 * It loads Next's request-storage singletons, which throw at import unless the
 * host provides `AsyncLocalStorage` (Next's own server installs it).
 */
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(ROOT, "src");
const API_DIR = join(SRC_DIR, "app", "api");

let getResponse: typeof NextTesting.unstable_getResponseFromNextConfig;
let nextConfig: NextConfig;

beforeAll(async () => {
  ({ unstable_getResponseFromNextConfig: getResponse } =
    await import("next/experimental/testing/server"));
  const configModule = (await import(
    /* @vite-ignore */ pathToFileURL(join(ROOT, "next.config.mjs")).href
  )) as { default: NextConfig };
  nextConfig = configModule.default;
});

async function headersFor(path: string): Promise<Headers> {
  return (await getResponse({ url: `http://localhost:3000${path}`, nextConfig })).headers;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** `sso/jwks.json/route.ts` → `/api/sso/jwks.json`, dynamic segments filled in. */
function samplePath(routeFile: string): string {
  const segments = routeFile
    .slice(API_DIR.length)
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "route.ts")
    .map((segment) => {
      if (segment.startsWith("[[...") || segment.startsWith("[...")) return "a/b.png";
      if (segment.startsWith("[")) return "x1";
      return segment;
    });
  return `/api/${segments.join("/")}`;
}

/** The route file's own source plus every `@/…` module it imports directly. */
function sourcesOf(routeFile: string): string[] {
  const source = readFileSync(routeFile, "utf8");
  const imported = [...source.matchAll(/from\s+"@\/([^"]+)"/g)].flatMap((m) => {
    const base = join(SRC_DIR, m[1]!);
    const file = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
    return file ? [readFileSync(file, "utf8")] : [];
  });
  return [source, ...imported];
}

/** A route that answers with its own cacheable policy (`public|private, max-age=…`). */
function setsOwnCaching(routeFile: string): boolean {
  return sourcesOf(routeFile).some((text) => /max-age=/i.test(text));
}

describe("I-07: /api responses are private, no-store unless the route caches on purpose", () => {
  const routeFiles = walk(API_DIR);

  it("discovers the API surface and the self-cached routes (the scan is not vacuous)", () => {
    expect(routeFiles.length).toBeGreaterThan(80);
    expect(routeFiles.filter(setsOwnCaching).map(samplePath).sort()).toEqual([
      "/api/docs/asset/a/b.png",
      "/api/help/asset/a/b.png",
      "/api/sso/jwks.json",
      "/api/v1/jwks.json",
      "/api/v1/openapi.json",
    ]);
  });

  it("sends no-store on every route that does not set its own caching", async () => {
    for (const file of routeFiles.filter((f) => !setsOwnCaching(f))) {
      const path = samplePath(file);
      expect((await headersFor(path)).get("cache-control"), path).toBe("private, no-store");
    }
  });

  it("leaves a self-cached route as the only writer of its Cache-Control", async () => {
    for (const file of routeFiles.filter(setsOwnCaching)) {
      const path = samplePath(file);
      expect((await headersFor(path)).get("cache-control"), path).toBeNull();
    }
  });

  it("covers Better Auth's catch-all and paths no route answers", async () => {
    for (const path of ["/api/auth/list-sessions", "/api/auth/admin/list-users", "/api/nope"]) {
      expect((await headersFor(path)).get("cache-control"), path).toBe("private, no-store");
    }
  });

  it("anchors each exclusion, so a look-alike path still gets no-store", async () => {
    for (const path of [
      "/api/v1/jwks.jsonx",
      "/api/v1/jwksxjson",
      "/api/sso/jwks.json/extra",
      "/api/v1/openapi.json.bak",
      "/api/docs/assetx/a.png",
      "/api/x/docs/asset/a.png",
    ]) {
      expect((await headersFor(path)).get("cache-control"), path).toBe("private, no-store");
    }
  });

  it("keeps the static security headers on /api and leaves pages to Next", async () => {
    const api = await headersFor("/api/administrator/users");
    expect(api.get("x-frame-options")).toBe("DENY");
    expect(api.get("x-content-type-options")).toBe("nosniff");
    const page = await headersFor("/en/app/dashboard");
    expect(page.get("x-frame-options")).toBe("DENY");
    expect(page.get("cache-control")).toBeNull();
  });
});
