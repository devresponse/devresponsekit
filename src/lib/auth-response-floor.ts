import { randomInt } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

/**
 * F-20: a minimum response time on the public endpoints that must not reveal
 * whether an account exists.
 *
 * Each of these endpoints gives the same answer for every address, but it does
 * different work depending on whether an account exists:
 *
 *   - `/sign-up/email`: an existing address returns straight after hashing the
 *     password (Better Auth hashes it on purpose, so both paths pay for it). A
 *     new address also creates the user, runs the `user.create` hooks
 *     (`resolveSignupPolicy`, `provisionUserFromAuth`) and links the
 *     credential: 16 queries against 3. Against a local Postgres, with the
 *     email already deferred, that measured 78 ms against 51 ms at the median.
 *     In production each extra query is a round trip to the database.
 *   - `/request-password-reset`: an existing address INSERTs the reset token,
 *     an unknown one runs Better Auth's dummy SELECT. Measured the same way:
 *     16 ms against 6 ms, most of it the INSERT's commit.
 *   - `/send-verification-email`: Better Auth already holds the signed-out
 *     branch to 500 ms, and both answers measured 510 ms. This hook adds only
 *     jitter there, and also covers the signed-in branch.
 *
 * The emails themselves are sent after the response (`deferEmailSend`), which
 * removes the largest part of the gap, the provider call. This floor bounds
 * what is left: no response to an HTTP call on these endpoints is sent before
 * {@link RESPONSE_FLOOR_MS} plus up to {@link RESPONSE_FLOOR_JITTER_MS} have
 * passed since the endpoint started. With it, all six cases above measured
 * 508-559 ms.
 *
 * Why 500 ms: Better Auth uses the same constant on `/send-verification-email`
 * to hide an external email send. The work left here is database work only.
 * The slowest case, a new-account sign-up, never exceeded 87 ms locally, and
 * that includes a password hash both paths pay for. So the floor leaves about
 * six times that for production round trips. A request that still overruns it
 * (a cold database connection, say) shows its real duration, so the floor
 * bounds the leak rather than removing it. The jitter blurs the floor's edge,
 * so a response that only just overruns it cannot be picked out from one
 * sample. It does not survive averaging; the headroom in the floor is what
 * does the work.
 *
 * Cost: the wait is a timer, not work. By the time it starts, the handler has
 * finished and released its database connections. Better Auth's rate limiter
 * refuses excess requests in `onRequest`, before any hook, so a flood gets a
 * fast 429 and is never held open. The per-IP budget is 3 per 10 s for
 * sign-up and 3 per 60 s for the other two.
 *
 * Scope: HTTP only. Better Auth sets `ctx.request` only for a routed request,
 * so the app's server-side `auth.api.*` calls (the administrator's "send
 * reset email", seeds) are not slowed. They come from an authenticated admin
 * or from tooling and reveal nothing to an outsider. `ctx.path` is the
 * endpoint's route pattern, so the match does not depend on how the URL was
 * spelled.
 *
 * The start time is keyed on the `Request` object. Better Auth passes the
 * same object to the before and after hooks, and a WeakMap lets an entry be
 * garbage-collected with its request when the after hook never runs (an
 * endpoint that threw a non-API error).
 */
export const RESPONSE_FLOOR_PATHS: readonly string[] = [
  "/sign-up/email",
  "/request-password-reset",
  "/send-verification-email",
];

/** Minimum time from the endpoint's start to its response (see module doc). */
export const RESPONSE_FLOOR_MS = 500;

/** Upper bound of the uniform random delay added on top of the floor. */
export const RESPONSE_FLOOR_JITTER_MS = 50;

interface FloorHookContext {
  path?: string;
  request?: Request;
}

/** True for an HTTP call to one of {@link RESPONSE_FLOOR_PATHS}. */
export function isResponseFloorCall(ctx: FloorHookContext): boolean {
  return (
    typeof ctx.request === "object" &&
    ctx.request !== null &&
    typeof ctx.path === "string" &&
    RESPONSE_FLOOR_PATHS.includes(ctx.path)
  );
}

export interface ResponseFloorOptions {
  /** Defaults to {@link RESPONSE_FLOOR_MS}. */
  floorMs?: number;
  /** Defaults to {@link RESPONSE_FLOOR_JITTER_MS}; 0 disables the jitter. */
  jitterMs?: number;
  /**
   * Returns a whole number from 0 up to, not including, `maxExclusive`.
   * Defaults to `crypto.randomInt`; tests pass a stub to pin the jitter.
   */
  random?: (maxExclusive: number) => number;
}

export const authResponseFloor = (options: ResponseFloorOptions = {}) => {
  const floorMs = options.floorMs ?? RESPONSE_FLOOR_MS;
  const jitterMs = options.jitterMs ?? RESPONSE_FLOOR_JITTER_MS;
  const random: (maxExclusive: number) => number = options.random ?? randomInt;
  const startedAt = new WeakMap<Request, number>();

  return {
    id: "response-floor",
    hooks: {
      before: [
        {
          matcher: isResponseFloorCall,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request) startedAt.set(ctx.request, performance.now());
          }),
        },
      ],
      after: [
        {
          matcher: isResponseFloorCall,
          handler: createAuthMiddleware(async (ctx) => {
            const started = ctx.request ? startedAt.get(ctx.request) : undefined;
            if (started === undefined || !ctx.request) return;
            startedAt.delete(ctx.request);
            const target = floorMs + (jitterMs > 0 ? random(jitterMs + 1) : 0);
            const remaining = target - (performance.now() - started);
            if (remaining > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
