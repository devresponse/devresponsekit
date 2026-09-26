import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isOperatorBearerAuthorized } from "@/lib/operator-bearer.server";

/**
 * The bearer check shared by every operator-secret endpoint: the
 * `/api/internal/*` scheduler routes (`outbox-drain`, `mcp-registration-reap`;
 * review #51 / #92) against `CRON_SECRET` and `/api/metrics` against
 * `METRICS_TOKEN` (I-08). Pins the fail-closed contract in isolation from any
 * one route's plumbing, and that no route keeps a copy of it.
 */
const SECRET = "test-cron-secret-value-at-least-32-chars-long";

function req(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://localhost/api/internal/anything", { headers });
}

describe("isOperatorBearerAuthorized", () => {
  it("accepts exactly the configured bearer", () => {
    expect(isOperatorBearerAuthorized(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it("FAILS CLOSED when no secret is configured — even with a bearer header", () => {
    expect(isOperatorBearerAuthorized(req(`Bearer ${SECRET}`), undefined)).toBe(false);
    expect(isOperatorBearerAuthorized(req(`Bearer ${SECRET}`), "")).toBe(false);
  });

  it("rejects a missing header, a non-Bearer scheme, and a wrong / prefix-only value", () => {
    expect(isOperatorBearerAuthorized(req(), SECRET)).toBe(false);
    expect(isOperatorBearerAuthorized(req(`Basic ${SECRET}`), SECRET)).toBe(false);
    expect(isOperatorBearerAuthorized(req("Bearer not-the-secret"), SECRET)).toBe(false);
    // Same length, one byte off — the constant-time compare must still say no.
    expect(isOperatorBearerAuthorized(req(`Bearer ${SECRET.slice(0, -1)}X`), SECRET)).toBe(false);
    // A prefix of the secret (length mismatch) must not authorize.
    expect(isOperatorBearerAuthorized(req(`Bearer ${SECRET.slice(0, 10)}`), SECRET)).toBe(false);
  });
});

/**
 * I-08: `/api/metrics` carried a hand-rolled copy of this check, so a
 * hardening of the helper would have silently missed it. These scans keep the
 * check in one place: a route that reads an operator secret must hand it to
 * the helper, and no route may carry a constant-time compare of its own.
 */
describe("one operator bearer check (I-08)", () => {
  const API_DIR = fileURLToPath(new URL("../../src/app/api", import.meta.url));
  const routes = readdirSync(API_DIR, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((path) => /(^|\/)route\.ts$/.test(path))
    .map((path) => ({ path, source: readFileSync(join(API_DIR, path), "utf8") }));
  const SECRETS = ["CRON_SECRET", "METRICS_TOKEN"] as const;

  it("every route that reads CRON_SECRET or METRICS_TOKEN checks it through the helper", () => {
    const readers = routes.filter(({ source }) =>
      SECRETS.some((secret) => source.includes(`.${secret}`)),
    );
    // The scan must see the routes it exists for, or it proves nothing.
    expect(readers.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "internal/mcp-registration-reap/route.ts",
        "internal/outbox-drain/route.ts",
        "metrics/route.ts",
      ]),
    );
    const unchecked = readers.flatMap(({ path, source }) =>
      SECRETS.filter((secret) => source.includes(`.${secret}`))
        .filter(
          (secret) =>
            !new RegExp(
              `isOperatorBearerAuthorized\\(\\s*request,\\s*[\\w.()]*\\.${secret}\\s*,?\\s*\\)`,
            ).test(source),
        )
        .map((secret) => `${path} (${secret})`),
    );
    expect(unchecked).toEqual([]);
  });

  it("no route carries a constant-time compare of its own", () => {
    const copies = routes
      .filter(({ source }) => /\btimingSafeEqual\b/.test(source))
      .map(({ path }) => path);
    expect(copies).toEqual([]);
  });
});
