import { checkOriginSuffix, normalizeOriginSuffix } from "@/lib/admin/origin-suffixes";

/**
 * Value checks for the env schema (`src/lib/env.ts`) that need more than a
 * zod primitive (F-22). Each returns a problem sentence, or `null` when the
 * value is acceptable; the schema turns a sentence into a boot failure.
 *
 * Why these exist: the kit's production `SSO_HANDOFF_ISSUER` sat at
 * `httsp://demo.devresponse.ca` for a week. It passed `z.string().min(1)`,
 * the handoff code's own guard missed it (`new URL("httsp://x").origin` is
 * the STRING `"null"`, not `null`), the kit stamped it into every token as
 * `iss`, and every satellite answered 401 while every check stayed green.
 * `z.url()` would not have caught it either: it accepts any scheme.
 *
 * Like `env.ts`, this module stays free of `server-only` so `tsx` scripts can
 * import it. `drk-deploy` (`vercel-cli/src/lib/env-spec.ts` and `secrets.ts`)
 * cannot import it across its package boundary and mirrors
 * {@link httpOriginProblem} and {@link ed25519PrivateJwkProblem} instead;
 * `tests/unit/env-validators.test.ts` (origins) and
 * `tests/unit/env-signing-keys.test.ts` (keys) run each pair over the same
 * vectors.
 *
 * It must also stay pure and free of Node APIs: `env.ts` is in the Edge
 * instrumentation bundle's import graph, where Turbopack swaps a Node
 * built-in for a stub that throws and flags any other Node API
 * (`tests/unit/edge-import-graph.test.ts` fails on both). So the key rule
 * here checks shape only. Importing the key needs `node:crypto`, and that
 * happens in `src/lib/env-signing-keys.server.ts`, which the Node branch of
 * `register()` in `src/instrumentation.ts` runs at boot.
 */

/**
 * Loopback hosts, where plain http never leaves the machine. `next build`
 * parses the placeholder env under `NODE_ENV=production` with
 * `http://localhost:3000`, and CI runs `next start` (also production) against
 * the same origin, so these stay allowed in production.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // The WHATWG parser has already normalised IPv4 spellings (`127.1`,
  // `0x7f.0.0.1`) to dotted quads and bracketed IPv6.
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export interface HttpOriginOptions {
  /** `NODE_ENV === "production"`: https is required except on a loopback host. */
  production: boolean;
  /**
   * The value is compared as an EXACT string by a peer — it is stamped into
   * tokens as `iss` and the verifier matches it character for character — so
   * it must be written exactly as `URL.origin` spells it: lowercase, no
   * trailing slash. Without `exact`, a trailing slash and a capitalised host
   * are tolerated, because the code that builds URLs from those variables
   * re-parses the value or trims the slash (`trustedOrigins`, the MCP
   * metadata and dispatch hop, the invitation link, the Mailgun client).
   * The one place such a value is used as written is `BETTER_AUTH_URL`
   * standing in for an unset `API_JWT_ISSUER` as the JWT `iss`, which the
   * kit's own verifier reads the same way (docs/configuration.md §1).
   */
  exact?: boolean;
}

/**
 * Checks that `value` is an http(s) ORIGIN: `scheme://host[:port]`, nothing
 * more. Rejects another scheme (`httsp:`, `ftp:`), a value the URL parser
 * repairs (`https:/host` parses as `https://host/`), a path, query, fragment
 * or credentials, and plain http in production unless the host is loopback.
 */
export function httpOriginProblem(value: string, options: HttpOriginOptions): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute http(s) origin such as https://app.example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `must use the http: or https: scheme, not "${url.protocol}"`;
  }
  const canonical = url.origin;
  if (options.exact) {
    if (value === `${canonical}/`) {
      return `must not end with "/": it is compared as an exact string, so drop the trailing slash (${canonical})`;
    }
    if (value !== canonical) {
      return `must be written exactly as an origin, scheme://host[:port] in lowercase with no path, query, fragment or credentials (${canonical})`;
    }
  } else {
    const lowered = value.toLowerCase();
    if (lowered !== canonical && lowered !== `${canonical}/`) {
      return `must be an origin, scheme://host[:port] with no path, query, fragment or credentials (${canonical})`;
    }
  }
  if (options.production && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "must use https: in production (plain http is accepted only for localhost, 127.0.0.1 or [::1])";
  }
  return null;
}

/** Splits a comma-separated env list; blank entries are dropped. */
export function splitEnvList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const COOKIE_DOMAIN_REASONS = {
  invalid_hostname: "it is not a plain host name (no scheme, port, path or wildcard)",
  ip_address: "an IP address cannot carry a domain cookie",
  public_suffix:
    'it is a public suffix (a bare TLD such as "com", or an entry such as "co.uk" or "github.io")',
  localhost_not_allowed: "localhost is not accepted in production",
} as const;

/**
 * Checks `COOKIE_DOMAIN` against the deployment's own origin. A browser
 * discards a `Domain=` cookie that does not cover the host that set it, and
 * one scoped to a public suffix, and the server never learns: sign-in answers
 * 200, the cookie is dropped, and the user is signed out on the next page.
 * `appUrl` is `BETTER_AUTH_URL`; when it does not parse, its own rule reports
 * that and this check stays quiet.
 *
 * The rules run on the normalised domain, but `src/lib/auth.ts` hands Better
 * Auth the RAW value and it reaches the browser verbatim as `Domain=<value>`.
 * A browser strips ONE leading dot and lowercases (RFC 6265 §5.2.3), and
 * nothing else: it drops `Domain=devresponse.ca.` and `Domain=..devresponse.ca`
 * on demo.devresponse.ca. So the raw value must also BE the checked domain,
 * give or take one leading dot and letter case. That refuses surrounding
 * whitespace too, as the origin rule does: a browser would trim a space, but
 * a newline makes the whole `Set-Cookie` header invalid.
 */
export function cookieDomainProblem(
  cookieDomain: string,
  appUrl: string,
  options: { production: boolean },
): string | null {
  const domain = normalizeOriginSuffix(cookieDomain);
  const verdict = checkOriginSuffix(domain, { allowLocalhost: !options.production });
  if (!verdict.ok) {
    return `must be a registrable domain such as .example.com: ${COOKIE_DOMAIN_REASONS[verdict.reason]}`;
  }
  if (cookieDomain.replace(/^\./, "").toLowerCase() !== domain) {
    return `must be written as ${domain} or .${domain}, with one optional leading dot, no trailing dot and no surrounding spaces: it is sent to the browser exactly as written, and a browser drops a cookie whose domain has a trailing or doubled dot`;
  }
  let host: string;
  try {
    host = new URL(appUrl).hostname;
  } catch {
    return null;
  }
  if (host !== domain && !host.endsWith(`.${domain}`)) {
    return `must be BETTER_AUTH_URL's host (${host}) or a parent domain of it: a browser drops a cookie for ${domain} set from that host, so every sign-in would silently not stick`;
  }
  return null;
}

/**
 * An Ed25519 JWK coordinate (`x` or `d`): 32 bytes as unpadded base64url
 * (RFC 8037 section 2, RFC 7515 section 2), which is always 43 characters.
 */
const ED25519_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks the SHAPE of `raw` as an Ed25519 private JWK, synchronously and
 * without Node APIs, so a key that cannot be used fails when the schema is
 * parsed instead of turning every token into a 500 or 401 later (F-22,
 * review #50): JSON, an object, kty OKP and crv Ed25519, and `x` and `d` each
 * 32 bytes of unpadded base64url. That catches a truncated or corrupted `d`,
 * a stray quote inside `x`, padding (`=`) and the standard `+` `/` alphabet.
 *
 * Shape cannot tell whether `x` is `d`'s public half (halves pasted from two
 * keys), and such a JWKS would publish a key that verifies nothing: that takes
 * an import, which `ed25519KeyPairProblem` in
 * `src/lib/env-signing-keys.server.ts` runs at Node boot. The sentences never
 * quote key material. `drk-deploy` carries a copy of both halves
 * (`vercel-cli/src/lib/secrets.ts`) for the values `env:sync` writes.
 */
export function ed25519PrivateJwkProblem(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "must be a JSON-encoded Ed25519 private JWK (it is not valid JSON)";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "must be a JSON-encoded Ed25519 private JWK (a JSON object)";
  }
  const { kty, crv, x, d } = parsed as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519") {
    return "must be an Ed25519 JWK (kty OKP, crv Ed25519)";
  }
  if (typeof d !== "string" || typeof x !== "string") {
    return "must carry both the private d and the public x member";
  }
  if (!ED25519_COORDINATE.test(d)) {
    return "has a d member that is not 43 unpadded base64url characters, the 32-byte private key (is d truncated or corrupted?)";
  }
  if (!ED25519_COORDINATE.test(x)) {
    return "has an x member that is not 43 unpadded base64url characters, the 32-byte public key (is x truncated or corrupted?)";
  }
  return null;
}
