import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/observability/logger.server";

/**
 * F-110: the `route.unhandled_error` line `onRequestError` writes to stdout.
 *
 * A page or server-component render mints no request id, so on a deployment
 * without Sentry the only key a user can quote is Next's digest: the error
 * boundary's Support ID, or the root boundary's Reference. The line used to
 * carry `{ requestId, err }` with no digest and no route, so an operator
 * holding a Support ID could match the report only by timestamp. Pinned: the
 * line carries the digest and Next's route pattern and type, and never the
 * concrete request path or its query.
 */
vi.mock("@sentry/nextjs", () => ({
  captureRequestError: () => undefined,
  withScope: (cb: (scope: { setTag: () => void }) => void) => cb({ setTag: () => undefined }),
}));

const errorCalls: unknown[][] = [];

beforeEach(() => {
  errorCalls.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.spyOn(logger, "error").mockImplementation(((...args: unknown[]) => {
    errorCalls.push(args);
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fire(error: unknown, path: string) {
  const { onRequestError } = await import("@/instrumentation");
  await onRequestError(
    error,
    { path, method: "GET", headers: {} },
    {
      routerKind: "App Router",
      routePath: "/[locale]/(secure)/app/administrator/users/[id]/page",
      routeType: "render",
    },
  );
}

describe("onRequestError log line (F-110)", () => {
  it("carries the digest the user sees, plus the route pattern and type", async () => {
    const error = Object.assign(new Error("render failed"), { digest: "2436375093" });
    await fire(error, "/en/app/administrator/users/u-123");

    expect(errorCalls).toHaveLength(1);
    const [obj, msg] = errorCalls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("route.unhandled_error");
    expect(obj).toMatchObject({
      err: { name: "Error", message: "render failed", digest: "2436375093" },
      routePath: "/[locale]/(secure)/app/administrator/users/[id]/page",
      routeType: "render",
    });
  });

  it("never writes the concrete request path or its query", async () => {
    const error = Object.assign(new Error("render failed"), { digest: "1" });
    await fire(error, "/en/app/administrator/users/u-123?token=opaque-invite-value");

    const line = JSON.stringify(errorCalls[0]);
    expect(line).not.toContain("u-123");
    expect(line).not.toContain("opaque-invite-value");
  });

  it("writes nothing to stdout in the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await fire(Object.assign(new Error("x"), { digest: "1" }), "/en");
    expect(errorCalls).toHaveLength(0);
  });
});
