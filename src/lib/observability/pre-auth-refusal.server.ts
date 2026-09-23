import "server-only";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { logger } from "@/lib/observability/logger.server";
import { preAuthRefusalsTotal } from "@/lib/observability/metrics.server";
import { normalizeRequestPath } from "@/lib/request-id";
import { boundedUserAgent } from "@/lib/user-agent";

/**
 * Records a request refused BEFORE its caller was authenticated (F-15) — on
 * the structured stdout stream and a Prometheus counter, never in
 * `app_audit_events`.
 *
 * Why not the audit table: a refusal decided before any session, credential
 * or signed token has been verified is one an anonymous client can trigger at
 * will. `app_audit_events` is append-only and trigger-protected, and retention
 * never removes a row younger than 30 days, so writing one row per such
 * refusal handed an unauthenticated curl loop (with an 8 KB `User-Agent`, from
 * many IPs) control over the growth of the largest table, and buried the real
 * `administrator.access.denied` rows under the noise. The sibling guards
 * (`requireApiPermission`, `requireAccountUser`) never wrote a row for their
 * origin refusal; the admin pipeline, the SSO consume endpoint and the
 * signed-out SSO launch did.
 *
 * The rule, for every entry point: a row is written once the request carries
 * something this server has VERIFIED — a session, an API key or JWT, or a
 * signed SSO handoff token — because from then on the volume follows
 * authenticated activity. Everything refused before that comes here instead.
 * The signal is kept, not dropped: the log line carries what the row carried
 * (event type, outcome, reason, correlation id, bounded `User-Agent`,
 * metadata) plus the method and normalized path, and the counter makes a
 * flood visible on a dashboard without reading logs. It carries NO client IP:
 * the stdout stream never does (the IP is user data — the Sentry policy drops
 * it, and the shared limiter logs only the scope half of a key for the same
 * reason); the edge's own access log has it.
 *
 * Level: a `denied` refusal (the origin guard) logs at `warn`. A `failure`
 * one (the SSO handoff's legacy outcome) logs at `error`, the level its
 * OBSERVABILITY-2 mirror line had while it was still an audit row, so an
 * alert keyed on that level keeps firing.
 *
 * Synchronous by design: a refusal path answers its 4xx without awaiting any
 * sink.
 */
export interface PreAuthRefusalInput {
  /** The event type the audit row used to carry (e.g. `administrator.access.denied`). */
  eventType: string;
  outcome: "denied" | "failure";
  /** A bounded, code- or library-supplied reason — never raw request data. */
  reason: string;
  /** The refused request; `nextUrl`, when present, supplies the path. */
  request: { headers: Headers; method?: string; nextUrl?: { pathname: string } };
  /** The id already echoed on the response; derived from the request when omitted. */
  requestId?: string | null;
  /** Structured context. MUST NOT contain secrets or unbounded request data. */
  metadata?: Record<string, unknown>;
}

export function logPreAuthRefusal(input: PreAuthRefusalInput): void {
  const { request } = input;
  preAuthRefusalsTotal.inc({ event_type: input.eventType });
  const fields = {
    kind: "pre_auth_refusal",
    requestId: input.requestId ?? getOrCreateRequestId(request),
    eventType: input.eventType,
    outcome: input.outcome,
    reason: input.reason,
    method: request.method,
    // Client-chosen on every route with a dynamic segment; normalized (length
    // cap, single line, origin-relative) or dropped, like the RSC denial row.
    path: normalizeRequestPath(request.nextUrl?.pathname) ?? undefined,
    userAgent: boundedUserAgent(request.headers),
    metadata: input.metadata,
  };
  const message = `pre-auth refusal ${input.eventType}`;
  if (input.outcome === "denied") logger.warn(fields, message);
  else logger.error(fields, message);
}
