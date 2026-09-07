/**
 * MCP agent self-registration — pure protocol layer (RFC 7591 Dynamic
 * Client Registration). No `server-only` imports, so the request schema,
 * response builder, and policy-mode mapping are trivially unit-testable.
 * The provisioning (DB writes) lives in `registration.server.ts`.
 *
 * See docs/design-mcp-agent-gateway.md §10.
 */
import { z } from "zod";

export type McpRegistrationMode = "approval" | "open";
export type McpRegistrationStatus = "active" | "pending_approval";

/**
 * Initial status for a newly self-registered agent, by policy mode.
 * `approval` parks the service account pending (it cannot even mint a token
 * until an admin activates it); `open` activates it, but the client is
 * still scopeless so every tool 403s until an admin grants scopes.
 */
export function statusForMode(mode: McpRegistrationMode): McpRegistrationStatus {
  return mode === "open" ? "active" : "pending_approval";
}

/**
 * RFC 7591 client-registration request. We accept the standard metadata but
 * ignore any requested `scope` (agents always start scopeless) and only ever
 * issue a client-credentials client. `organization` is a DevResponseKit
 * extension naming the target tenant; extra RFC 7591 fields are tolerated.
 */
export const registrationRequestSchema = z
  .object({
    client_name: z.string().trim().min(1).max(200),
    organization: z.string().trim().min(1).max(255).optional(),
    grant_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
    redirect_uris: z.array(z.string()).optional(),
  })
  .passthrough();

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

/**
 * Parses `MCP_REGISTRATION_ALLOWED_ORGS` (comma-separated slugs/ids) into a
 * normalized list: trimmed, lower-cased, empties dropped, duplicates kept
 * harmlessly (membership checks only).
 */
export function parseRegistrationOrgAllowList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether a RESOLVED org may be the target of a registration that named it
 * explicitly in `organization` (review #51).
 *
 * The check runs after resolution so the operator can configure a slug while
 * the caller sends the id (or vice versa) — both are compared. Rules:
 *   - a default org and/or an allow-list is configured → the org must be one
 *     of them; a default org alone therefore REFUSES every other org (before
 *     #51 a caller-supplied `organization` silently overrode the default);
 *   - neither is configured → any active org is permitted (the open
 *     multi-tenant mode, unchanged).
 * A refusal is reported to the caller as the same generic "Unknown
 * organization" rejection an unresolvable identifier gets, so the endpoint
 * never confirms that a tenant exists but is closed.
 */
export function isRegistrationOrgPermitted(
  org: { id: string; slug: string },
  policy: { defaultOrg: string | undefined; allowList: readonly string[] },
): boolean {
  const permitted = new Set(policy.allowList);
  const defaultOrg = policy.defaultOrg?.trim().toLowerCase();
  if (defaultOrg) permitted.add(defaultOrg);
  if (permitted.size === 0) return true;
  return permitted.has(org.slug.toLowerCase()) || permitted.has(org.id.toLowerCase());
}

/**
 * RFC 7592 (Dynamic Client Registration MANAGEMENT) is deliberately NOT
 * supported — review #206, decided rather than overlooked:
 *
 *   - The management API is authorized by a `registration_access_token`: a
 *     long-lived bearer, handed to an unauthenticated registrant, that can
 *     read and DELETE the client. Every other credential in this app is
 *     stored as a SHA-256 hash on its own row with a status and a revoke
 *     path; giving this one the same treatment needs a column, i.e. a core
 *     migration — an operator gate — for a capability nobody has asked for.
 *   - The lifecycle it would provide already exists, gated on an admin:
 *     approve / set scopes / revoke in the Agents console (§12) and
 *     `POST /api/v1/admin/oauth-clients/{id}/rotate-secret` for rotation.
 *     A self-registered agent is scopeless and (in `approval` mode) inert
 *     until an admin acts, so self-service revocation buys little and
 *     self-service *mutation* would hand an unapproved registrant a write
 *     path into the tenant.
 *
 * How this is ADVERTISED: RFC 7591 §3.2.1 makes both management members
 * optional, and RFC 7592 §1 keys the whole API on their presence — so a
 * response that omits `registration_access_token` and
 * `registration_client_uri` tells a compliant client, in the protocol's own
 * terms, that there is no management endpoint to call. {@link
 * buildRegistrationResponse} therefore omits them on purpose (pinned by
 * tests/unit/mcp-registration.test.ts), and no `registration_endpoint`
 * management URI is published in the discovery metadata.
 */
export interface RegistrationResponse {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  client_name: string;
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
}

export function buildRegistrationResponse(args: {
  clientId: string;
  clientSecret: string;
  clientName: string;
  issuedAt: number;
}): RegistrationResponse {
  return {
    client_id: args.clientId,
    client_secret: args.clientSecret,
    client_id_issued_at: args.issuedAt,
    client_secret_expires_at: 0, // never expires (rotate via the admin console)
    client_name: args.clientName,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "client_secret_post",
    scope: "", // ZERO scopes — an admin must grant before the agent can act
  };
}
