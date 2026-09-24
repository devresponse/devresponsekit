/**
 * Post-deploy verification against the running deployment.
 *
 * The kit exposes two probes: `/api/health` (no database) and
 * `/api/health/ready`, which checks the env, that the migration ledger contains
 * every core migration THIS build depends on, and (F-26) Better Auth's own
 * schema check. That second one is the whole reason a deploy can be verified
 * from outside: a build promoted ahead of its schema answers 503
 * `schema_behind` instead of 500ing on the first authenticated request, which
 * is how it used to surface.
 */

export type ReadyStatus = "ready" | "schema_behind" | "database_unreachable" | "config_invalid" | "unknown";

export interface HealthReport {
  health: number;
  ready: number;
  readyStatus: ReadyStatus;
  /** A bad-credentials sign-in: 401 means auth is alive, 500 means an outage. */
  signIn: number;
}

/**
 * The origin to probe, validated before anything is requested.
 *
 * It arrives from `.drk-deploy.json`, so it is file-sourced data driving an
 * outbound request — the flow CodeQL's `js/file-access-to-http` rule is about.
 * Probing an operator-configured origin IS this command's purpose, so the
 * answer is not to avoid the flow but to constrain it: parse the value,
 * require http(s), and use only the parsed `origin`, discarding any path,
 * query, credentials or fragment someone put in the config. A malformed entry
 * then fails here with a clear message instead of as a puzzling fetch error.
 */
function probeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Not a valid origin: ${origin}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Origin must be http(s), got ${url.protocol}`);
  }
  return url.origin;
}

/**
 * Identifies this CLI's probes in a deployment's logs and audit table.
 *
 * Both probes below deliberately make a request that is REJECTED, and both
 * rejections are audited by the app. Naming the client is what keeps those
 * rows from reading as a failed intrusion attempt weeks later.
 */
const PROBE_USER_AGENT = "drk-deploy-probe (post-deploy verification)";

/** Requests one path under an already-validated origin. Never throws. */
async function statusOf(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ code: number; body: string }> {
  const target = new URL(path, base);
  try {
    const response = await fetch(target, { ...init, signal: AbortSignal.timeout(30_000) });
    return { code: response.status, body: await response.text().catch(() => "") };
  } catch {
    return { code: 0, body: "" };
  }
}

/**
 * Probes a deployment the way an operator would, including the one request
 * that has twice been the difference between "deployed" and "outage": a
 * sign-in with deliberately wrong credentials. 401 means the auth path is
 * alive; 500 means the build is up but broken.
 */
export async function probe(origin: string): Promise<HealthReport> {
  const base = probeOrigin(origin);

  const health = await statusOf(base, "/api/health");
  const ready = await statusOf(base, "/api/health/ready");
  const signIn = await statusOf(base, "/api/auth/sign-in/email", {
    method: "POST",
    // Identifiable, for the same reason as the consumer probe: this request
    // leaves a failed-sign-in audit row behind on every run.
    headers: { "Content-Type": "application/json", Origin: base, "User-Agent": PROBE_USER_AGENT },
    body: JSON.stringify({
      email: "drk-deploy-probe@invalid.example",
      password: "not-a-real-password-used-only-to-prove-401",
    }),
  });

  let readyStatus: ReadyStatus = "unknown";
  if (ready.code === 200) readyStatus = "ready";
  else if (ready.body.includes("schema_behind")) readyStatus = "schema_behind";
  else if (ready.body.includes("database_unreachable")) readyStatus = "database_unreachable";
  else if (ready.body.includes("config_invalid")) readyStatus = "config_invalid";

  return { health: health.code, ready: ready.code, readyStatus, signIn: signIn.code };
}

/* ------------------------------------------------------------------ */
/*  Satellite (consumer) probe                                         */
/* ------------------------------------------------------------------ */

/**
 * A deliberately invalid handoff token.
 *
 * Not a JWT at all, so verification fails at parse time and no network call to
 * the issuer's JWKS is even attempted. It carries no secret, no identifier and
 * nothing user-derived — it exists purely to make the consume endpoint say
 * "no".
 */
const GARBAGE_HANDOFF_TOKEN = "drk-deploy-probe.not-a-real-token";

export interface ConsumerHealthReport {
  health: number;
  /** A satellite's readiness is plain database reachability: 200 or 503. */
  ready: number;
  /**
   * `GET /api/sso/consume` with a garbage token. 401 is the healthy answer:
   * the endpoint is mounted, configured, and refusing.
   */
  consume: number;
}

/**
 * Probes a SATELLITE, which is a different animal from the kit.
 *
 * The kit's probe asks whether the issuer publishes a signing key. A satellite
 * publishes none by design, so asking that question of a consumer reports
 * failure forever and trains the operator to ignore the check. What a consumer
 * can actually prove from outside is: it serves, it can reach its database,
 * and its SSO consume endpoint is mounted and refuses a token it cannot
 * verify. A 500 there is the interesting failure — it means the audience
 * variables are missing, which otherwise stays invisible until the first real
 * handoff arrives.
 *
 * WHAT IT LEAVES BEHIND, stated plainly because it is not nothing: the consume
 * route audits every rejection, so each probe appends one
 * `sso.consume.failure` row (reason: the token parse error). On a satellite
 * sharing the kit's database that row lands in the PRIMARY's audit table. It
 * is one append-only row per `status` or `deploy`, which is the price of
 * proving the endpoint is mounted and refusing rather than assuming it — the
 * kit's own probe makes the same trade with its bad-credentials sign-in. The
 * User-Agent below is what makes those rows identifiable afterwards, so nobody
 * investigates this CLI as a failed intrusion.
 */
export async function probeConsumer(origin: string): Promise<ConsumerHealthReport> {
  const base = probeOrigin(origin);

  const health = await statusOf(base, "/api/health");
  const ready = await statusOf(base, "/api/health/ready");
  const consume = await statusOf(
    base,
    `/api/sso/consume?token=${encodeURIComponent(GARBAGE_HANDOFF_TOKEN)}`,
    { headers: { "User-Agent": PROBE_USER_AGENT } },
  );

  return { health: health.code, ready: ready.code, consume: consume.code };
}

export function isConsumerHealthy(report: ConsumerHealthReport): boolean {
  return report.health === 200 && report.ready === 200 && report.consume === 401;
}

export function describeConsumer(report: ConsumerHealthReport): string[] {
  const lines = [
    `/api/health           ${report.health === 200 ? "200 OK" : `${report.health || "unreachable"}`}`,
    `/api/health/ready     ${report.ready === 200 ? "200 ready" : `${report.ready || "unreachable"} — the app cannot reach its database`}`,
    `sso consume (garbage) ${report.consume === 401 ? "401 (refused, as it must)" : `${report.consume || "unreachable"} — expected 401`}`,
  ];
  if (report.consume === 500) {
    lines.push("");
    lines.push(
      "A 500 from /api/sso/consume means its audience is not configured: SSO_HANDOFF_AUDIENCE_PREFIX or",
    );
    lines.push(
      "SSO_HANDOFF_APPLICATION_ID is missing. The app boots clean and fails on the FIRST real handoff.",
    );
  }
  if (report.consume === 429) {
    lines.push("");
    lines.push("429 means the consume endpoint rate-limited this probe — re-run it in a minute.");
  }
  if (report.consume === 200) {
    lines.push("");
    lines.push(
      "A 200 for a garbage token would mean the endpoint accepts unverified tokens. Stop and investigate.",
    );
  }
  return lines;
}

/** The SSO issuer's published keys — empty means handoffs cannot be verified. */
export async function jwksKeyCount(origin: string): Promise<number | null> {
  const { code, body } = await statusOf(probeOrigin(origin), "/api/sso/jwks.json");
  if (code !== 200) return null;
  try {
    const parsed = JSON.parse(body) as { keys?: unknown[] };
    return Array.isArray(parsed.keys) ? parsed.keys.length : null;
  } catch {
    return null;
  }
}

/** True when the probe shows a deployment that is actually serving correctly. */
export function isHealthy(report: HealthReport): boolean {
  return report.health === 200 && report.ready === 200 && report.signIn === 401;
}

export function describe(report: HealthReport): string[] {
  const lines = [
    `/api/health           ${report.health === 200 ? "200 OK" : `${report.health || "unreachable"}`}`,
    `/api/health/ready     ${report.ready === 200 ? "200 ready" : `${report.ready || "unreachable"} ${report.readyStatus}`}`,
    `sign-in (bad creds)   ${report.signIn === 401 ? "401 (auth alive)" : `${report.signIn || "unreachable"} — expected 401`}`,
  ];
  if (report.readyStatus === "schema_behind") {
    lines.push("");
    lines.push(
      "The build is live but its schema is behind: run `drk-deploy migrate` against the direct endpoint.",
    );
    lines.push(
      "If the log says auth-schema-behind, redeploy afterwards: Better Auth keeps refusing until it restarts.",
    );
  }
  if (report.readyStatus === "config_invalid") {
    lines.push("");
    lines.push(
      "An environment variable fails the kit's schema: the runtime log names it (kind config-invalid).",
    );
  }
  if (report.signIn === 500) {
    lines.push("");
    lines.push(
      "A 500 on sign-in means the deployment is serving but auth is broken — check the runtime logs.",
    );
  }
  return lines;
}
