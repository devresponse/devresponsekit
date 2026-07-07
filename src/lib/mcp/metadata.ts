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
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Canonical resource identifier (RFC 8707) for the MCP endpoint. */
export function mcpResourceIdentifier(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/api/mcp`;
}

/** URL of the protected-resource metadata document (RFC 9728). */
export function protectedResourceMetadataUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/.well-known/oauth-protected-resource`;
}

/**
 * `WWW-Authenticate` value for a 401 from the protected MCP resource
 * (RFC 9728 §5.1) — points the client at the metadata so it can discover
 * the authorization server and obtain a token.
 */
export function mcpWwwAuthenticate(baseUrl: string): string {
  return `Bearer realm="devresponse-mcp", resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`;
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
    resource: `${base}/api/mcp`,
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
}

export function buildAuthorizationServerMetadata(
  baseUrl: string,
  issuer: string,
): AuthorizationServerMetadata {
  const base = trimTrailingSlash(baseUrl);
  return {
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
  };
}
