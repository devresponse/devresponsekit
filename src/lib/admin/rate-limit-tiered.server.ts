import "server-only";
import {
  rateLimitKey,
  type RateLimitOptions,
  type RateLimitResult,
} from "@/lib/admin/rate-limit.server";
import { consumeSharedToken } from "@/lib/admin/rate-limit-shared.server";

/**
 * Two-tier PRE-AUTH floor (F-18): a per-source bucket (the trusted client IP)
 * in front of a deployment-wide one, both consumed from the SHARED Postgres
 * bucket (review #98), and consumed in that order.
 *
 * The token endpoint, MCP registration and the CSP sink each paired a per-IP
 * bucket with a `__global__` floor, and all three took the GLOBAL token first.
 * Every request the IP bucket then refused had already spent a deployment-wide
 * token, so one IP sending faster than the global refill rate held the global
 * budget at zero while its own requests were 429'd: every tenant's
 * client_credentials sign-in and MCP agent token mint failed, and the CSP sink
 * dropped every real violation report deployment-wide. The global floor exists
 * to cap what MANY sources add up to, so it may only be charged for a request
 * that its source bucket admitted.
 *
 * So the per-source bucket is checked first, and the global floor is touched
 * only for a request that bucket admitted. A request refused per source never
 * decrements the global budget. The accepted trade-off is the reverse case: a
 * request the global floor refuses has already spent one per-source token.
 * That costs the refused caller one token of its OWN budget and nobody else
 * anything, where the old order let one caller spend everyone's.
 *
 * Why one helper: the order is the whole invariant, and three hand-written
 * copies had all got it wrong the same way. Call sites name the scope and the
 * source; the global key is spelled only here, and
 * tests/unit/rate-limit-shared-floors-invariant.test.ts fails if `__global__`
 * appears anywhere else under src/. It lives in its own module, not in
 * rate-limit-shared.server.ts, so it reaches `consumeSharedToken` through the
 * module boundary: the route suites replace that primitive with an in-memory
 * bucket, and an intra-module call would bypass the replacement, so those
 * suites could not pin this order.
 */

/** Actor half of the deployment-wide key: `<scope>:__global__`. */
const GLOBAL_ACTOR = "__global__";

/** The two budgets of a tiered floor. */
export interface TieredRateLimits {
  /** Per-source budget (the trusted client IP). Checked first. */
  source: RateLimitOptions;
  /** Deployment-wide budget, charged only for requests `source` admitted. */
  global: RateLimitOptions;
}

/**
 * Same shape as `RateLimitResult`, plus which tier refused. `retryAfterSeconds`
 * is the refusing bucket's own wait, as it was when each route checked the two
 * buckets itself.
 */
export type TieredRateLimitResult =
  { ok: true } | (Extract<RateLimitResult, { ok: false }> & { tier: "source" | "global" });

/**
 * Consumes one token from `<scope>:<source>` and, only if that was admitted,
 * one from `<scope>:__global__`. `source` is the caller's trusted identity for
 * the floor (`clientIpKey(request.headers)`), never a value from the body.
 */
export async function consumeSourceThenGlobal(
  scope: string,
  source: string,
  limits: TieredRateLimits,
  nowMs?: number,
): Promise<TieredRateLimitResult> {
  const sourceCheck = await consumeSharedToken(rateLimitKey(scope, source), limits.source, nowMs);
  if (!sourceCheck.ok) return { ...sourceCheck, tier: "source" };
  const globalCheck = await consumeSharedToken(
    rateLimitKey(scope, GLOBAL_ACTOR),
    limits.global,
    nowMs,
  );
  if (!globalCheck.ok) return { ...globalCheck, tier: "global" };
  return { ok: true };
}
