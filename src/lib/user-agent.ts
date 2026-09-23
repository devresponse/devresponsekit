/**
 * The `User-Agent` value the app is willing to record (F-15).
 *
 * The header is wholly client-chosen and has no useful length limit of its
 * own: a single request can carry kilobytes of it. It lands in two sinks —
 * `app_audit_events.user_agent`, an append-only, trigger-protected table that
 * only the retention job may prune (and never below 30 days), and the
 * structured stdout stream — so an uncapped value let one request park an
 * arbitrary blob in each. Real agents are a few hundred characters at most;
 * 512 keeps every one of them whole and caps the rest, the same bound
 * `normalizeRequestPath` puts on the recorded pathname for the same reason.
 *
 * Framework-free (no `server-only`, no DB) so the audit writer and the
 * pre-authentication refusal logger share one answer without either pulling
 * in the other's module graph.
 */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * The request's `User-Agent`, cut to {@link USER_AGENT_MAX_LENGTH}, or `null`
 * when there is no request or no header. An empty header stays `""` — the
 * value is recorded as sent, only its length is bounded.
 */
export function boundedUserAgent(headers: Headers | null | undefined): string | null {
  const value = headers?.get("user-agent") ?? null;
  if (value === null || value.length <= USER_AGENT_MAX_LENGTH) return value;
  return value.slice(0, USER_AGENT_MAX_LENGTH);
}
