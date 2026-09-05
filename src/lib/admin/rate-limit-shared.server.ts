import "server-only";
import type { NextResponse } from "next/server";
import { sql, type Kysely } from "kysely";
import type { AppDatabase } from "@/db/schema/app-schema";
import {
  consumeToken,
  rateLimitDeniedResponse,
  rateLimitKey,
  type RateLimitOptions,
  type RateLimitResult,
} from "@/lib/admin/rate-limit.server";
import { logger } from "@/lib/observability/logger.server";
import { rateLimitSharedFallbacksTotal } from "@/lib/observability/metrics.server";

/**
 * Postgres-backed token bucket for the PRE-AUTH rate-limit floors (source
 * review 2026-09-04, #98).
 *
 * The in-memory limiter (`rate-limit.server.ts`) is per process. On Vercel a
 * process is one lambda invocation, so the "deployment-wide" floors on the
 * token endpoint, MCP registration, the CSP sink and invitation acceptance
 * were really per-lambda floors: an attacker who fans a credential-stuffing
 * or registration run out across invocations multiplied every budget by the
 * instance count, and the docs that called them global overstated them.
 * These floors are the ones where the ATTACKER chooses the fan-out (nothing
 * has authenticated yet), so they — and only they — consume from a bucket
 * every instance shares: one row per key in `app_rate_limits` (migration
 * 0006). Authenticated per-actor limits stay in memory: an actor first has
 * to hold a credential, so the fan-out is bounded by what they hold, and a
 * DB round trip on every admin mutation would buy little.
 *
 * Same contract as `consumeToken` — `(key, options, nowMs?) → RateLimitResult`
 * — but async, because the bucket lives in the database. Call sites that
 * previously called `consumeToken` for a pre-auth floor now `await` this
 * instead; an invariant test greps them to keep it that way.
 *
 * Atomicity: refill-and-consume is ONE statement,
 * `INSERT … ON CONFLICT DO UPDATE … WHERE refilled >= 1 RETURNING`, with the
 * bucket math in SQL against the stored `updated_at`. The `WHERE` gates the
 * update, so a denied request writes nothing and returns no row, and Postgres
 * evaluates it against the row's LATEST version under the conflict lock — N
 * concurrent consumers of one key serialise and exactly the budgeted number
 * succeed (proved by tests/db/rate-limit-shared.db.test.ts). A denied request
 * leaves `(tokens, updated_at)` untouched rather than materialising the
 * refill; that is equivalent because `min(cap, min(cap, x) + y) = min(cap, x + y)`
 * for `y >= 0`, and it keeps the deny path write-free.
 *
 * Failure policy: when the database cannot be reached (or the table is not
 * there yet) the floor MUST NOT fail open silently, and it must not fail
 * closed either — a 503 on every token mint and CSP report during a DB blip
 * would turn a limiter into a self-inflicted outage on endpoints that the
 * blip may not otherwise affect (the CSP sink needs no database at all). So
 * a backend error falls back to the in-process bucket for the SAME key (the
 * pre-#98 behaviour, per-instance but real), logs ONE structured warning, and
 * bumps `devresponsekit_rate_limit_shared_fallbacks_total{scope}` so the
 * degraded state is visible on the metrics scrape; the backend is then
 * skipped for {@link SHARED_FALLBACK_COOLDOWN_MS} so a dead database costs
 * one failed round trip per cool-down per instance, not one per request
 * (each would otherwise wait out the pool's connect timeout).
 *
 * Housekeeping: rows are pruned opportunistically — at most once per
 * {@link SHARED_PRUNE_INTERVAL_MS} per process, fire-and-forget, deleting
 * keys untouched for more than {@link SHARED_STALE_AFTER_MS}. A key idle that
 * long has fully refilled for every budget this module accepts (it refuses a
 * budget whose `capacity / refillPerSec` exceeds the window, since deleting a
 * partially-refilled bucket would grant a full one), so a prune never changes
 * an outcome and the table stays bounded to the recently active key set.
 */

/** Rows untouched for longer than this are stale and may be pruned (1 h). */
export const SHARED_STALE_AFTER_MS = 60 * 60 * 1000;
/** Minimum spacing between opportunistic prunes from one process (10 min). */
export const SHARED_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/** After a backend error, skip the database for this long (30 s). */
export const SHARED_FALLBACK_COOLDOWN_MS = 30 * 1000;

let lastPruneAtMs = Number.NEGATIVE_INFINITY;
let backendUnavailableUntilMs = Number.NEGATIVE_INFINITY;

/** Test-only: forget the prune / fallback timers. */
export function __resetSharedRateLimitForTests(): void {
  lastPruneAtMs = Number.NEGATIVE_INFINITY;
  backendUnavailableUntilMs = Number.NEGATIVE_INFINITY;
}

/**
 * The prune contract only holds when every bucket fully refills within the
 * stale window; a slower budget would be granted a fresh burst by the prune.
 * A programming error, so it throws at the call site rather than degrading.
 */
function assertPrunable(options: RateLimitOptions): void {
  if (!(options.capacity >= 1) || !(options.refillPerSec > 0)) {
    throw new RangeError(
      `shared rate limit: capacity must be >= 1 and refillPerSec > 0 (got ${options.capacity}, ${options.refillPerSec})`,
    );
  }
  const secondsToFull = options.capacity / options.refillPerSec;
  if (secondsToFull * 1000 > SHARED_STALE_AFTER_MS) {
    throw new RangeError(
      `shared rate limit: a bucket must fully refill within ${SHARED_STALE_AFTER_MS / 1000}s ` +
        `(capacity ${options.capacity} / ${options.refillPerSec} per second = ${secondsToFull}s); ` +
        `the opportunistic prune would otherwise grant it a fresh burst`,
    );
  }
}

type AppDb = Kysely<AppDatabase>;
let dbPromise: Promise<AppDb> | undefined;

/**
 * Lazy, ONCE-per-process handle on the app database: keeps `@/db/database`
 * (and its pool) out of this module's static graph — the CSP sink imports
 * the limiter and needs no database — while resolving the module exactly one
 * time, so the consume path and the fire-and-forget prune never race two
 * dynamic imports of the same module.
 */
function getDb(): Promise<AppDb> {
  return (dbPromise ??= import("@/db/database").then((m) => m.db));
}

interface ConsumeRow {
  /** Balance after this consume; `null` when the request was denied. */
  tokens_after: number | null;
  /** The row as it was BEFORE this statement (snapshot); `null` when absent. */
  prior_tokens: number | null;
  prior_updated_at: Date | null;
}

async function consumeViaDatabase(
  key: string,
  options: RateLimitOptions,
  nowMs: number,
): Promise<RateLimitResult> {
  const db = await getDb();
  const { capacity, refillPerSec } = options;
  // Clock skew between instances (review #98 follow-up): an instance whose
  // clock LAGS the last writer's presents an `excluded.updated_at` earlier
  // than the stored one. Elapsed is clamped at 0 so a lagging clock never
  // un-refills the bucket (an unclamped `-0.5 s` would take 3 → 2.5 tokens),
  // and the stored timestamp is `greatest(...)` so it never moves backwards
  // either — otherwise the NEXT caller on the true clock would be credited
  // the lag as free refill. Both clamps are pinned by
  // tests/db/rate-limit-shared.db.test.ts ("the clock never runs backwards").
  const { rows } = await sql<ConsumeRow>`
    with attempt as (
      insert into app_rate_limits as r (key, tokens, updated_at)
      values (${key}, ${capacity}::numeric - 1, to_timestamp(${nowMs}::double precision / 1000.0))
      on conflict (key) do update
        set tokens = least(
              excluded.tokens + 1,
              r.tokens
                + greatest(0, extract(epoch from (excluded.updated_at - r.updated_at)))
                  * ${refillPerSec}::numeric
            ) - 1,
            updated_at = greatest(r.updated_at, excluded.updated_at)
        where least(
              excluded.tokens + 1,
              r.tokens
                + greatest(0, extract(epoch from (excluded.updated_at - r.updated_at)))
                  * ${refillPerSec}::numeric
            ) >= 1
      returning r.tokens
    )
    select
      (select tokens::float8 from attempt) as tokens_after,
      r.tokens::float8 as prior_tokens,
      r.updated_at as prior_updated_at
    from (select 1) as one
    left join app_rate_limits as r on r.key = ${key}
  `.execute(db);

  const row = rows[0];
  if (row?.tokens_after !== null && row?.tokens_after !== undefined) return { ok: true };

  // Denied. `Retry-After` is informational, so it is computed from the
  // statement's snapshot of the row (its state before any concurrent writer),
  // mirroring the in-memory arithmetic. A row that vanished between the
  // conflict and the snapshot (another instance's prune) yields the
  // one-token wait. Elapsed is clamped at 0 for the same clock-skew reason as
  // the SQL above: a stored timestamp AHEAD of this instance's clock must not
  // shrink the balance (pinned by the unit suite's lagging-clock case).
  let refilled = 0;
  if (row?.prior_tokens !== null && row?.prior_tokens !== undefined && row.prior_updated_at) {
    const elapsedSec = Math.max(0, (nowMs - row.prior_updated_at.getTime()) / 1000);
    refilled = Math.min(capacity, row.prior_tokens + elapsedSec * refillPerSec);
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / Math.max(refillPerSec, 1e-9)));
  return { ok: false, retryAfterSeconds };
}

/**
 * Deletes every bucket untouched for longer than {@link SHARED_STALE_AFTER_MS}
 * as of `nowMs`. Returns the number of rows removed. Exported for the DB
 * tests; production reaches it only through the opportunistic call inside
 * {@link consumeSharedToken}.
 */
export async function pruneStaleSharedBuckets(nowMs: number = Date.now()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(nowMs - SHARED_STALE_AFTER_MS);
  const result = await db
    .deleteFrom("app_rate_limits")
    .where("updated_at", "<", cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

function maybePrune(nowMs: number): void {
  if (nowMs - lastPruneAtMs < SHARED_PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = nowMs;
  // Fire-and-forget: a prune never delays or fails the request that
  // triggered it; a failure is logged and simply retried next interval.
  void pruneStaleSharedBuckets(nowMs).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "shared rate-limit prune failed; will retry next interval",
    );
  });
}

/** The scope half of a key — safe to log (the actor half may be an IP). */
function scopeOf(key: string): string {
  const idx = key.indexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}

/**
 * Refills `key`'s SHARED bucket from the stored timestamp and consumes one
 * token, in one atomic statement against Postgres. Same result shape as
 * `consumeToken`; see the module comment for the failure policy.
 */
export async function consumeSharedToken(
  key: string,
  options: RateLimitOptions,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  assertPrunable(options);
  if (nowMs < backendUnavailableUntilMs) {
    // Inside the cool-down after a backend error: per-instance, deliberately.
    return consumeToken(key, options, nowMs);
  }
  try {
    const result = await consumeViaDatabase(key, options, nowMs);
    maybePrune(nowMs);
    return result;
  } catch (err: unknown) {
    backendUnavailableUntilMs = nowMs + SHARED_FALLBACK_COOLDOWN_MS;
    const scope = scopeOf(key);
    rateLimitSharedFallbacksTotal.inc({ scope });
    logger.warn(
      {
        scope,
        cooldownMs: SHARED_FALLBACK_COOLDOWN_MS,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      "shared rate-limit backend unavailable; pre-auth floor is per-instance until it recovers",
    );
    return consumeToken(key, options, nowMs);
  }
}

/**
 * Async twin of `enforceRateLimit` for a pre-auth floor that speaks the
 * AdminError envelope (invitation acceptance): consumes from the SHARED
 * bucket and, on deny, answers exactly as the in-memory helper does (metric,
 * flood-gated audit, 429 + `Retry-After`).
 */
export async function enforceSharedRateLimit(
  scope: string,
  actorId: string,
  options: RateLimitOptions,
  request?: { headers: Headers },
  requestId?: string,
  nowMs?: number,
): Promise<NextResponse | null> {
  const result = await consumeSharedToken(rateLimitKey(scope, actorId), options, nowMs);
  if (result.ok) return null;
  return rateLimitDeniedResponse(scope, actorId, result, request, requestId, nowMs);
}
