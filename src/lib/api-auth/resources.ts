/**
 * RFC 8707 resource indicators for the token endpoint (review #50/#53).
 *
 * The deployment exposes exactly two protected resources, both derived from
 * the app's own origin (`BETTER_AUTH_URL`) so the allow-list can never be
 * widened by a client-supplied value:
 *
 *   - `<origin>/api/v1`  — the versioned machine API. Its JWT audience stays
 *     `API_JWT_AUDIENCE` (default `devresponse-api`) so every token minted
 *     before this change, and every third-party verifier pinned on that
 *     string (docs/api-security.md §5), keeps working. A token request that
 *     omits `resource` gets this audience.
 *   - `<origin>/api/mcp` — the MCP gateway (RFC 9728 `resource`). Its
 *     audience IS the resource identifier, so `/api/mcp` can require an
 *     audience a plain v1 token never carries.
 *
 * Pure (no `server-only`, no env access) so the token route, the caller
 * resolver, the discovery metadata and the tests share one definition.
 */

export type TokenResourceKind = "v1" | "mcp";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Canonical resource identifier (RFC 8707) for the v1 machine API. */
export function v1ResourceIdentifier(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/api/v1`;
}

/** Canonical resource identifier (RFC 8707 / RFC 9728) for the MCP endpoint. */
export function mcpResourceIdentifier(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/api/mcp`;
}

/** Every resource the token endpoint will mint for, in advertised order. */
export function supportedResources(baseUrl: string): string[] {
  return [v1ResourceIdentifier(baseUrl), mcpResourceIdentifier(baseUrl)];
}

/**
 * The `aud` claim minted for a resource. The v1 audience is the configured
 * `API_JWT_AUDIENCE` (backward compatible); the MCP audience is the MCP
 * resource identifier itself.
 */
export function audienceForResource(
  kind: TokenResourceKind,
  env: { BETTER_AUTH_URL: string; API_JWT_AUDIENCE: string },
): string {
  return kind === "mcp" ? mcpResourceIdentifier(env.BETTER_AUTH_URL) : env.API_JWT_AUDIENCE;
}

/** The audience `/api/mcp` requires (a convenience over {@link audienceForResource}). */
export function mcpAudience(env: { BETTER_AUTH_URL: string }): string {
  return mcpResourceIdentifier(env.BETTER_AUTH_URL);
}

/**
 * True when two absolute URLs denote the SAME identifier (WHATWG-normalised
 * origin + path, trailing slash ignored). Used for RFC 8707 resource matching
 * and — because RFC 8414 requires an authorization server's `issuer` to be the
 * URL its metadata is served from — to check that `API_JWT_ISSUER` and
 * `BETTER_AUTH_URL` agree before the MCP discovery documents advertise them
 * (review #57). Non-absolute input never matches.
 */
export function isSameIdentifier(a: string, b: string): boolean {
  const left = normalizeIdentifier(a);
  const right = normalizeIdentifier(b);
  return left !== null && right !== null && left === right;
}

export type ResolvedResource = { kind: TokenResourceKind; resource: string };

/**
 * Matches a client-supplied `resource` parameter against the allow-list.
 *
 * Returns `null` for anything that is not one of the two supported
 * identifiers — a relative reference, a foreign origin, a fragment (RFC 8707
 * §2 forbids one), a query string, or a sub-path. The only normalisation is
 * the standard URL parse (scheme/host case, default port) plus a trailing
 * slash, so `https://app.example.com/api/mcp/` matches and
 * `https://app.example.com/api/mcp/tools` does not: a resource indicator is an
 * identifier, not a prefix. `undefined` / empty means "not requested" and
 * resolves to the v1 default so existing clients are unaffected.
 */
export function resolveRequestedResource(
  raw: string | undefined,
  baseUrl: string,
): ResolvedResource | null {
  if (raw === undefined || raw.trim() === "") {
    return { kind: "v1", resource: v1ResourceIdentifier(baseUrl) };
  }
  // An empty query/fragment (`…/api/mcp?`, `…/api/mcp#`) parses to "" for
  // `search` / `hash`, so test the raw string rather than the parsed members.
  const trimmed = raw.trim();
  if (trimmed.includes("#") || trimmed.includes("?")) return null;
  const candidate = normalizeIdentifier(trimmed);
  if (candidate === null) return null;
  const v1 = v1ResourceIdentifier(baseUrl);
  if (candidate === normalizeIdentifier(v1)) return { kind: "v1", resource: v1 };
  const mcp = mcpResourceIdentifier(baseUrl);
  if (candidate === normalizeIdentifier(mcp)) return { kind: "mcp", resource: mcp };
  return null;
}

/**
 * `origin + pathname` per the WHATWG URL parser (lower-cased scheme/host,
 * default port dropped) minus any trailing slash — applied to BOTH sides of
 * the comparison so a `BETTER_AUTH_URL` written with a capitalised host still
 * matches the client's spelling. `null` when the value is not an absolute URL.
 */
function normalizeIdentifier(value: string): string | null {
  try {
    const parsed = new URL(value);
    return trimTrailingSlash(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return null;
  }
}
