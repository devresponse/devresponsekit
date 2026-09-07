/**
 * OAuth 2.1 discovery metadata for the MCP agent gateway (Phase 1, design
 * docs/design-mcp-agent-gateway.md §9): RFC 9728 protected-resource
 * metadata and RFC 8414 authorization-server metadata. Pure builders (no
 * `server-only`) — the route handlers read env and pass the base URL +
 * issuer in, so these stay trivially unit-testable.
 *
 * The app is BOTH the resource server (`/api/mcp`) and the authorization
 * server (the existing `/api/v1/auth/token` + `/api/v1/jwks.json`), so the
 * metadata simply points a client at endpoints that already exist.
 */
import { mcpResourceIdentifier, supportedResources } from "@/lib/api-auth/resources";
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

// The resource identifier now lives with the token endpoint's allow-list
// (review #50/#53) so the metadata, the minted `aud` and the gateway's
// expected audience can never drift apart; re-exported for existing callers.
export { mcpResourceIdentifier };

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface McpDiscoveryConfig {
  /** Origin the discovery documents and every endpoint they name are served from. */
  baseUrl: string;
  /** The authorization-server `issuer` — the same value tokens carry as `iss`. */
  issuer: string;
}

/**
 * The ONE (baseUrl, issuer) pair both discovery documents are built from
 * (review #57). Before this each route derived the pair itself, so the
 * protected-resource document could name an authorization server whose own
 * metadata was never served there.
 *
 * RFC 8414 §3.3 requires an issuer to be the URL its metadata is retrieved
 * from, and this app serves that metadata (plus the token endpoint and JWKS)
 * under `BETTER_AUTH_URL` alone. `API_JWT_ISSUER` is therefore only allowed
 * to be unset or the same identifier — enforced at boot by the env schema
 * when `MCP_ENABLED`, so nothing here has to reconcile a divergence.
 */
export function mcpDiscoveryConfig(env: {
  BETTER_AUTH_URL: string;
  API_JWT_ISSUER?: string;
}): McpDiscoveryConfig {
  const baseUrl = trimTrailingSlash(env.BETTER_AUTH_URL);
  return { baseUrl, issuer: trimTrailingSlash(env.API_JWT_ISSUER ?? baseUrl) };
}

/** URL of the protected-resource metadata document (RFC 9728). */
export function protectedResourceMetadataUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/.well-known/oauth-protected-resource`;
}

/**
 * `WWW-Authenticate` value for a 401 from the protected MCP resource
 * (RFC 9728 §5.1) — points the client at the metadata so it can discover
 * the authorization server and obtain a token. `challenge` adds the RFC 6750
 * §3 `error` / `error_description` attributes (e.g. `invalid_token` for a
 * token minted for another resource, review #50/#53); the description must
 * not contain a double quote.
 */
export function mcpWwwAuthenticate(
  baseUrl: string,
  challenge?: { error: string; description: string },
): string {
  const base = `Bearer realm="devresponse-mcp", resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`;
  if (!challenge) return base;
  const description = challenge.description.replace(/"/g, "'");
  return `${base}, error="${challenge.error}", error_description="${description}"`;
}

export interface ProtectedResourceMetadata {
  resource: string;
  resource_name: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

export function buildProtectedResourceMetadata(
  baseUrl: string,
  issuer: string,
): ProtectedResourceMetadata {
  const base = trimTrailingSlash(baseUrl);
  return {
    // The identifier a client passes as `resource=` at the token endpoint
    // (RFC 8707) and the `aud` the gateway requires (review #50/#53).
    resource: mcpResourceIdentifier(base),
    resource_name: "DevResponseKit MCP gateway",
    authorization_servers: [trimTrailingSlash(issuer)],
    scopes_supported: [...API_SCOPE_CATALOG],
    bearer_methods_supported: ["header"],
    resource_documentation: `${base}/en/app/docs`,
  };
}

export interface AuthorizationServerMetadata {
  issuer: string;
  token_endpoint: string;
  jwks_uri: string;
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  response_types_supported: string[];
  /**
   * The RFC 8707 `resource` values the token endpoint accepts (review
   * #50/#53). Not an IANA-registered AS-metadata member — RFC 8414 §2
   * permits additional members — but it lets a client discover, without
   * trial and error, that `resource=<origin>/api/mcp` is what an MCP-bound
   * token needs.
   */
  resources_supported: string[];
  /** RFC 7591 DCR endpoint — present only when self-registration is enabled. */
  registration_endpoint?: string;
}

export function buildAuthorizationServerMetadata(
  baseUrl: string,
  issuer: string,
  options?: { registrationEndpoint?: boolean },
): AuthorizationServerMetadata {
  const base = trimTrailingSlash(baseUrl);
  const metadata: AuthorizationServerMetadata = {
    issuer: trimTrailingSlash(issuer),
    token_endpoint: `${base}/api/v1/auth/token`,
    jwks_uri: `${base}/api/v1/jwks.json`,
    // The token endpoint also accepts a non-standard `api_key` grant; only the
    // standard client-credentials grant is advertised for OAuth clients.
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: [...API_SCOPE_CATALOG],
    // No authorization-code / implicit flow yet (Phase 5) → no response types.
    response_types_supported: [],
    resources_supported: supportedResources(base),
  };
  if (options?.registrationEndpoint) {
    metadata.registration_endpoint = `${base}/api/mcp/register`;
  }
  return metadata;
}
