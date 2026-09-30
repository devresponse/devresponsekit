import { createHmac } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { RateLimitOptions, RateLimitResult } from "@/lib/http/rate-limit.server";

/**
 * F-55: failed email/password sign-ins leave a trace, and one account's
 * guesses have a budget however many addresses they come from.
 *
 * Before this, a failed `/sign-in/email` was recorded nowhere the app reads
 * (only a success writes `auth.session.created`), and Better Auth's own log
 * lines carry no email, IP or request id. The only throttle was Better Auth's
 * per-IP limit (3 per 10 s), so a credential-stuffing run against one account
 * from 1,000 addresses got about 300 guesses a second, and nobody saw it until
 * one guess worked.
 *
 * Two hooks on HTTP `/sign-in/email`, a plugin because Better Auth takes only
 * one global `hooks.before` (`rejectClosedAuthEndpoints`) and one
 * `hooks.after`:
 *
 *   - `before`: a per-ACCOUNT bucket, {@link SIGN_IN_EMAIL_LIMIT}, in the
 *     shared Postgres bucket (`rate-limit-shared.server.ts`), next to Better
 *     Auth's per-IP one, which runs first (in `onRequest`, before any hook).
 *     Every attempt on an address costs one token, taken BEFORE the password
 *     is verified, so a refused attempt pays for no hash and learns nothing.
 *     A refusal is Better Auth's own 429 (same body, `X-Retry-After`), so it
 *     cannot be told from the per-IP one, and the bucket is keyed on whatever
 *     address was submitted, existing or not, so it reveals no account.
 *   - `after`: a failed attempt (any `APIError`: a wrong password, an unknown
 *     address, `EMAIL_NOT_VERIFIED`, `BANNED_USER`, a malformed body) logs one
 *     `pre_auth_refusal` line with {@link SIGN_IN_FAILED_EVENT_TYPE} and
 *     counts it in `devresponsekit_pre_auth_refusals_total` (F-15's rule: the
 *     caller is unverified, so it is a log line, never an append-only audit
 *     row an anonymous loop could grow). A throttled attempt is logged the same
 *     way by the `before` hook, with reason `rate_limited`, because a
 *     `before`-hook refusal skips every `after` hook.
 *
 * The address never appears in either place: the bucket key and the log line
 * carry {@link signInEmailDigest}, an HMAC keyed with the auth secret, so
 * someone reading the log stream or `app_rate_limits` cannot test candidate
 * addresses against it, while an operator holding the secret can compute the
 * digest for an address to find its lines (docs/troubleshooting.md). The line
 * carries no client IP, like every `pre_auth_refusal` line; the edge's access
 * log has it.
 *
 * NOT A LOCKOUT. A per-account limit is something anyone can spend, the
 * account's owner included, so it is shaped to throttle a guessing run without
 * becoming a way to keep the owner out:
 *
 *   - it is a token bucket, not a lock: nothing is recorded but a token count,
 *     nobody has to unlock anything, and the owner gets a token back 90
 *     seconds after the last attempt and the full budget within 15 minutes of
 *     an attack stopping;
 *   - ten attempts are more than a person mistyping needs, and the per-IP
 *     limit already stops one client well before that;
 *   - it follows Better Auth's own limiter switch (`rateLimit.enabled`, on in
 *     production, off under `AUTH_RATE_LIMIT_DISABLED`), so the browser suites
 *     that sign the same account in many times are unaffected;
 *   - a limiter fault never refuses a sign-in: the shared bucket falls back to
 *     the in-process one if the database is unreachable, and anything that
 *     still throws is logged and the attempt proceeds under the per-IP limit.
 *
 * Scope: HTTP only (`ctx.request`). The app's server-side `auth.api.*` calls
 * (seeds) are neither throttled nor logged. `ctx.path` is the endpoint's route
 * pattern, so the match does not depend on how the URL was spelled.
 */
export const SIGN_IN_EMAIL_PATH = "/sign-in/email";

/** Limiter scope of the per-account bucket (the key's readable half). */
export const SIGN_IN_EMAIL_RATE_LIMIT_SCOPE = "auth.signin.email";

/**
 * Ten attempts per address, refilled at ten per 15 minutes (one every 90 s).
 * Full within 15 minutes, well inside the shared bucket's one-hour prune
 * window, so a pruned row can never hand out more than a full budget.
 */
export const SIGN_IN_EMAIL_LIMIT: RateLimitOptions = {
  capacity: 10,
  refillPerSec: 10 / (15 * 60),
};

/** `eventType` of the `pre_auth_refusal` line a failed sign-in logs. */
export const SIGN_IN_FAILED_EVENT_TYPE = "auth.sign_in.failed";

/** Better Auth's own 429 message, so both limits answer alike. */
const TOO_MANY_REQUESTS_MESSAGE = "Too many requests. Please try again later.";

/**
 * The pseudonymous identity of a submitted address: HMAC-SHA256 keyed with the
 * auth secret over a purpose label and the address lower-cased, the one
 * normalisation Better Auth's own lookup applies, so every spelling that
 * reaches one account shares one bucket and one digest.
 */
export function signInEmailDigest(secret: string, email: string): string {
  return createHmac("sha256", secret).update(`sign-in-email:${email.toLowerCase()}`).digest("hex");
}

/** The submitted address, or `null` when the body has none (the endpoint 400s). */
function submittedEmail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const email = (body as { email?: unknown }).email;
  return typeof email === "string" && email.length > 0 ? email : null;
}

/**
 * The `reason` a failure is logged with: Better Auth's error code, which is a
 * library constant. Anything that does not look like one (it never should) is
 * reduced to the status, so no request data can reach the field.
 */
function failureReason(error: { body?: { code?: unknown }; statusCode: number }): string {
  const code = error.body?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : `http_${error.statusCode}`;
}

/**
 * Logs and counts one failed attempt. Best-effort: a sign-in answer must never
 * change because logging failed, so nothing here can throw into the hook.
 */
async function logSignInFailure(
  request: Request,
  reason: string,
  emailHash: string | null,
): Promise<void> {
  try {
    // Lazy: the logger is `server-only`, and `pnpm db:auth:migrate` loads the
    // auth instance outside Next without the `react-server` condition.
    const { logPreAuthRefusal } = await import("@/lib/observability/pre-auth-refusal.server");
    logPreAuthRefusal({
      eventType: SIGN_IN_FAILED_EVENT_TYPE,
      outcome: "denied",
      reason,
      request: {
        headers: request.headers,
        method: request.method,
        nextUrl: { pathname: new URL(request.url).pathname },
      },
      metadata: { emailHash },
    });
  } catch {
    // Nothing left to log with.
  }
}

/**
 * Takes one token from the address's bucket. Anything but a clean answer is
 * logged and treated as "allowed" (see the module doc, NOT A LOCKOUT).
 */
async function consumeSignInToken(emailHash: string): Promise<RateLimitResult> {
  try {
    const { consumeSharedToken } = await import("@/lib/http/rate-limit-shared.server");
    const { rateLimitKey } = await import("@/lib/http/rate-limit.server");
    return await consumeSharedToken(
      rateLimitKey(SIGN_IN_EMAIL_RATE_LIMIT_SCOPE, emailHash),
      SIGN_IN_EMAIL_LIMIT,
    );
  } catch (error) {
    try {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("per-account sign-in limit could not be checked; attempt allowed", {
        err: error,
      });
    } catch {
      // Nothing left to log with.
    }
    return { ok: true };
  }
}

interface SignInHookContext {
  path?: string;
  request?: Request;
}

/** True for an HTTP call to `/sign-in/email`. */
export function isSignInEmailCall(ctx: SignInHookContext): boolean {
  return typeof ctx.request === "object" && ctx.request !== null && ctx.path === SIGN_IN_EMAIL_PATH;
}

export const signInAttempts = () =>
  ({
    id: "sign-in-attempts",
    hooks: {
      before: [
        {
          matcher: isSignInEmailCall,
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request || !ctx.context.rateLimit.enabled) return;
            const email = submittedEmail(ctx.body);
            if (email === null) return;
            const emailHash = signInEmailDigest(ctx.context.secret, email);
            const result = await consumeSignInToken(emailHash);
            if (result.ok) return;
            try {
              const { rateLimitDenialsTotal } = await import("@/lib/observability/metrics.server");
              rateLimitDenialsTotal.inc({ scope: SIGN_IN_EMAIL_RATE_LIMIT_SCOPE });
            } catch {
              // A missed count must not turn a 429 into a 500.
            }
            await logSignInFailure(ctx.request, "rate_limited", emailHash);
            throw new APIError(
              "TOO_MANY_REQUESTS",
              { message: TOO_MANY_REQUESTS_MESSAGE },
              { "X-Retry-After": String(result.retryAfterSeconds) },
            );
          }),
        },
      ],
      after: [
        {
          matcher: isSignInEmailCall,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!ctx.request || !isAPIError(returned)) return;
            const email = submittedEmail(ctx.body);
            await logSignInFailure(
              ctx.request,
              failureReason(returned),
              email === null ? null : signInEmailDigest(ctx.context.secret, email),
            );
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
