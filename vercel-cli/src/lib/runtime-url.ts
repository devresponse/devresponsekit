import { CliError } from "./log.js";
import { parsePostgresUrl, pooledReason, repointingParams } from "./migration-target.js";

/**
 * The runtime `DATABASE_URL` `drk-deploy db:runtime-login` writes to Vercel
 * (DEP4): the owner's DIRECT URL with the new login's name and password, on
 * the endpoint the app should use. Pure, so every rule is table-tested, and
 * no message it throws ever carries the password or a URL.
 */

/** Which endpoint the runtime connects through. */
export type RuntimeEndpoint = "pooled" | "direct";

export const RUNTIME_ENDPOINTS: readonly RuntimeEndpoint[] = ["pooled", "direct"];

/**
 * The query parameters the runtime URL keeps: TLS and channel binding, which
 * say how to connect, not where. Everything else goes, `options` included:
 * a transaction pooler refuses startup parameters (08P01), so on a pooled
 * endpoint `search_path` and the two timeouts come from the login's role
 * defaults, which the kit command set and verified without any.
 */
const KEPT_PARAMS = ["sslmode", "channel_binding"] as const;

/** A host `--pooled-host` may name: the kit command's `--verify-host` rule (no scheme, port or path). */
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * Neon's pooled host for a direct one: `-pooler` after the endpoint id, the
 * first label (`ep-x-123.us-east-2.aws.neon.tech` →
 * `ep-x-123-pooler.us-east-2.aws.neon.tech`). Null for any other provider,
 * whose pooled host cannot be derived and must be named.
 */
export function neonPooledHost(host: string): string | null {
  const lower = host.toLowerCase();
  if (!lower.endsWith(".neon.tech")) return null;
  const [first = "", ...rest] = lower.split(".");
  if (first === "" || rest.length === 0 || first.endsWith("-pooler")) return null;
  return [`${first}-pooler`, ...rest].join(".");
}

/**
 * The host the runtime connects to: the owner's for `direct`; for `pooled`,
 * `--pooled-host`, or else Neon's derivation. A refusal (exit 2) names the
 * flag to pass, never the URL.
 */
export function runtimeHost(
  ownerUrl: string,
  options: { endpoint: RuntimeEndpoint; pooledHost?: string | undefined },
): string {
  const owner = parsePostgresUrl(ownerUrl);
  if (!owner || owner.hostname === "") {
    throw new CliError("The owner URL is not a postgres:// connection string with a host.", { exitCode: 2 });
  }
  const pooled = pooledReason(owner);
  if (pooled) {
    throw new CliError(`The owner URL is already pooled: ${pooled}.`, {
      exitCode: 2,
      hint: "Use the owner's DIRECT URL: the login is created there, and the runtime's pooled host is derived from it (Neon) or named with --pooled-host.",
    });
  }
  if (options.endpoint === "direct") {
    if (options.pooledHost !== undefined) {
      throw new CliError("--pooled-host is for --endpoint pooled.", { exitCode: 2 });
    }
    return owner.hostname;
  }
  if (options.pooledHost !== undefined) {
    if (!HOST_RE.test(options.pooledHost)) {
      throw new CliError(
        `--pooled-host ${options.pooledHost} is not a host name (no scheme, port or path).`,
        {
          exitCode: 2,
        },
      );
    }
    return options.pooledHost;
  }
  const derived = neonPooledHost(owner.hostname);
  if (derived === null) {
    throw new CliError(`The pooled host of ${owner.hostname} cannot be derived: only Neon's can.`, {
      exitCode: 2,
      hint: "Name it with --pooled-host <host> (your provider's pooled endpoint for the same database), or run the app on the direct endpoint with --endpoint direct.",
    });
  }
  return derived;
}

/**
 * The runtime `DATABASE_URL`: the owner's URL with `login` and `password` as
 * its credentials, {@link runtimeHost} as its host, the same port and
 * database, and only {@link KEPT_PARAMS} of its query.
 *
 * The password is base64url, so it embeds unescaped. The result is checked
 * once more (a postgres:// URL, nothing in the query that re-points it)
 * before it is returned.
 */
export function runtimeUrl(
  ownerUrl: string,
  options: {
    login: string;
    password: string;
    endpoint: RuntimeEndpoint;
    pooledHost?: string | undefined;
  },
): string {
  const host = runtimeHost(ownerUrl, options);
  const url = parsePostgresUrl(ownerUrl)!;
  const kept = KEPT_PARAMS.flatMap((name) => {
    const value = url.searchParams.get(name);
    return value === null ? [] : [[name, value] as const];
  });
  url.username = options.login;
  url.password = options.password;
  url.hostname = host;
  url.search = "";
  url.hash = "";
  for (const [name, value] of kept) url.searchParams.set(name, value);
  const result = url.toString();
  const check = parsePostgresUrl(result);
  // A `postgres:` URL keeps its host's case, so the host is compared without it.
  if (!check || check.hostname.toLowerCase() !== host.toLowerCase() || repointingParams(check).length > 0) {
    throw new CliError("Could not build the runtime URL from the owner URL.", { exitCode: 2 });
  }
  return result;
}
