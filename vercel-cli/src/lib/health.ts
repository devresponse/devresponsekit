/**
 * Post-deploy verification against the running deployment.
 *
 * The kit exposes two probes: `/api/health` (no database) and
 * `/api/health/ready`, which checks that the migration ledger contains every
 * core migration THIS build depends on. That second one is the whole reason a
 * deploy can be verified from outside: a build promoted ahead of its schema
 * answers 503 `schema_behind` instead of 500ing on the first authenticated
 * request, which is how it used to surface.
 */

export type ReadyStatus = "ready" | "schema_behind" | "database_unreachable" | "unknown";

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
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({
      email: "drk-deploy-probe@invalid.example",
      password: "not-a-real-password-used-only-to-prove-401",
    }),
  });

  let readyStatus: ReadyStatus = "unknown";
  if (ready.code === 200) readyStatus = "ready";
  else if (ready.body.includes("schema_behind")) readyStatus = "schema_behind";
  else if (ready.body.includes("database_unreachable")) readyStatus = "database_unreachable";

  return { health: health.code, ready: ready.code, readyStatus, signIn: signIn.code };
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
  }
  if (report.signIn === 500) {
    lines.push("");
    lines.push(
      "A 500 on sign-in means the deployment is serving but auth is broken — check the runtime logs.",
    );
  }
  return lines;
}
