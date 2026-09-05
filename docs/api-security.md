---
title: "API Security & Third-Party Applications"
description: How to expose the machine API safely and how to secure third-party applications — credential choice, least privilege, verification, revocation, MCP agents, and satellite apps.
group: General
order: 75
---

# API Security & Third-Party Applications

_Audience: **operators** who grant API access to integrations and third parties, and **third-party developers** who build against the platform. This is the practical hardening companion to the [API Reference](./api.md); the canonical mechanism-level design is [Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md). Where this prose and the code disagree, the code wins — fix the doc._

---

## 1. The security model in one page

Every external surface converges on the same five properties, enforced in code rather than by convention:

| Property | Meaning | Where it's enforced |
| --- | --- | --- |
| **Dark by default** | `/api/v1` bearer auth, JWT issuance, the MCP gateway, and agent self-registration are all **off** until explicitly enabled per environment. | `API_KEYS_ENABLED`, `API_JWT_ENABLED`, `MCP_ENABLED`, `MCP_REGISTRATION_ENABLED` — see [Configuration](./configuration.md#machine-api-credentials-both-paths-dark-by-default) |
| **Least privilege by construction** | A credential's effective authority is **`scopes ∩ owner's live permissions`**, checked at every request *and* at minting — no credential can out-scope its creator, and a bearer credential can never mint a broader one. | `src/lib/api-auth/scopes.ts`, `v1-guard.server.ts` ([design §7](./design-api-keys-and-tokens.md#7-scope-model--the-intersection-rule)) |
| **Tenant binding** | A credential acts in the organization it was minted for — never the browser's active-org cookie. Out-of-scope resources return **404**, not 403. | resolver MACHINE-1 ([design §3](./design-api-keys-and-tokens.md#3-caller-resolution)) |
| **No plaintext at rest** | Key and client secrets are shown **once** and stored only as SHA-256 hashes; JWTs are stateless and hold no server secret. There is no "show me the secret again" endpoint. | [design §5](./design-api-keys-and-tokens.md#5-api-keys), [§9](./design-api-keys-and-tokens.md#9-secret-handling) |
| **Everything audited** | Issuance, denials, and mutations write audit events carrying the same `requestId` as the response's `x-request-id` header. | `api.access.denied`, `token.issued`, `mcp.client.registered`, … |

Keep those five in mind and the rest of this page is corollaries.

## 2. Which credential should a third party get?

Match the integration shape to the credential — don't default everything to a long-lived API key.

| The third party is… | Give them | Why | Reference |
| --- | --- | --- | --- |
| A server-side integration or scheduled job | An **API key** (`drk_…`) with narrow scopes and an **expiry** | Simplest; hash-verified per request; revocable and rotatable | [API Reference §2](./api.md#2-authentication) |
| A service making many calls, or one you want strong lifecycle control over | An **OAuth client** (`client_credentials`) that exchanges for **short-lived JWTs** | The long-lived secret is only ever presented to the token endpoint; resource calls carry a ≤15-minute token; per-workload down-scoping | [design §2](./design-api-keys-and-tokens.md#2-oauth2-client-credentials-principals), [§6](./design-api-keys-and-tokens.md#6-jwt-access-tokens--jwks) |
| An AI agent (MCP client) | **MCP self-registration** (or an admin-created OAuth client) — zero scopes until approved | Registration is gated, quota'd, and the agent can authenticate but do nothing until an admin grants scopes | [§7 below](#7-third-party-ai-agents-mcp), [API Reference §11](./api.md#11-mcp-agent-gateway-model-context-protocol) |
| A web app on one of your subdomains reusing platform sign-in | A **satellite app** on the SSO handoff (Options A/B) | Per-app cookie, per-app secret, ≤60s single-use handoff tokens — compromise stays contained | [§8 below](#8-third-party-and-satellite-web-apps), [Satellite Apps Integration Guide](./integration-satellite-apps.md) |
| An end user automating their own account | Their own key with **`account.*` scopes** only | Self-service surface; needs no `admin.*` grant at all | [design §5.4](./design-api-keys-and-tokens.md#54-the-accountapikeysmanage-scope) |

**Never** hand a third party: a human user's credentials, a cookie session, the `BETTER_AUTH_SECRET`, the `SSO_HANDOFF_PRIVATE_KEY` (a satellite never needs it — it verifies handoffs against the public JWKS), or a wildcard-scoped credential you wouldn't grant them permission-by-permission.

## 3. Operator playbook — granting access safely

1. **Create a dedicated service user per third party.** Never bind a third party's credential to a human's account: credentials inherit their owner's live permissions, so the human's role changes silently change the integration's authority — and off-boarding the human kills the integration. A per-party service user also gives you a clean audit line and an independent kill switch.
2. **Bind it to the right organization.** Credentials are org-bound at mint time (MACHINE-1); a third party serving one tenant must get a credential minted in that tenant.
3. **Grant permissions through a role, then scope the credential to a subset.** Effective authority is the intersection, so use both levers: the service user's role is the ceiling, the credential's scopes narrow it per credential. List scopes explicitly; avoid `.*` wildcards for third parties (a wildcard is grantable only if you hold every key under the prefix, and it silently widens as the catalog grows).
4. **Prefer client-credentials for third parties.** The API key is fine for your own scripts; for an external party, an OAuth client + short-lived JWT means the durable secret transits your network only at token exchange, and every resource call carries a token that dies in minutes.
5. **Set an expiry.** `API_KEY_DEFAULT_TTL_DAYS` gives the UI a default; a key with no `expires_at` lives until revoked. Third-party keys should always expire — renewal is your periodic re-authorization checkpoint.
6. **Agree a rotation cadence and use the rotate endpoints.** `POST /api/v1/me/api-keys/{id}/rotate` and `…/admin/oauth-clients/{id}/rotate-secret` swap the secret atomically (the old key is revoked in the same transaction), so rotation is a config update on their side, not an outage.
7. **Watch the audit log and usage stamps.** `last_used_at`/`last_used_ip` on keys, `token.issued` and `api.access.denied` events, and per-request `x-request-id` correlation give you the "is this credential behaving?" view (`admin.audit.read`, or **Administrator → Audit**).
8. **Know your kill switches before you need them** — see [§6](#6-revocation--incident-response).

## 4. Third-party developer obligations (consumer side)

If you are the integrator calling this platform:

- **Store the secret in a secret manager** (or your platform's encrypted env store). The plaintext is shown exactly once; there is no recovery endpoint — losing it means asking for a rotation. Never commit it, never bake it into an image, never put it in a URL or query string.
- **Exchange for down-scoped tokens per workload.** The token endpoint accepts a `scope` parameter that narrows the token to a subset of the credential's scopes ([API Reference §5](./api.md#5-machine-api-apiv1)). A worker that only reads users should run on a `admin.users.read`-only token even if the client is granted more.
- **Keep one credential per app and per environment.** The `drk_live_…` / `drk_test_…` env tag exists so environments don't share secrets; sharing one key across apps destroys the audit trail and makes rotation a multi-team incident.
- **Handle the error model deliberately** ([API Reference §4](./api.md#4-error-model)):
  - `401` — missing/invalid/revoked credential, or the path is disabled server-side (both bearer paths are dark by default). Do not retry with backoff forever; alert.
  - `403` — the scope ∩ permission check failed. This is a **configuration** problem (yours or the operator's), not a transient one.
  - `404` — may mean *out of tenant scope*, not just "doesn't exist" — existence is deliberately not leaked.
  - `412` — your `If-Match` ETag is stale; re-`GET` and reapply your change.
  - `429` — back off per `Retry-After` (with jitter). Mutations are rate-limited **per credential**, so a runaway loop starves only itself.
- **Log the `x-request-id`** of failures and quote it when reporting problems — it matches the operator's audit rows. Never log the `Authorization` header.
- **Pin nothing about token internals.** Treat the JWT as opaque unless you are a resource server (below); its claims, TTL, and `kid` can change within the documented contract.

## 5. Verifying platform JWTs in your own service

If your third-party service *receives* platform-issued JWTs (e.g. the platform calls you, or you operate a sidecar that trusts platform identity), verify them **statelessly against the JWKS** — you need no shared secret:

1. Fetch `GET /api/v1/jwks.json` and cache it (it is served with `Cache-Control: public, max-age=300`). Re-fetch on an unknown `kid` — that is how zero-downtime key rotation reaches you ([design §6.4](./design-api-keys-and-tokens.md#64-key-rotation--verify-only-window)).
2. Require `alg: EdDSA` (Ed25519). Reject anything else — especially `HS256`/`none`.
3. Verify the signature against the JWKS key selected by the token's `kid`.
4. Check `iss` equals the platform's configured issuer (`API_JWT_ISSUER`, default its `BETTER_AUTH_URL`) and `aud` equals the audience of the resource you are (RFC 8707): the v1 machine-API audience is `API_JWT_AUDIENCE` (`devresponse-api` by default) and is what a token request without a `resource` parameter gets; a token requested with `resource=<origin>/api/mcp` carries that identifier as its `aud` instead and is **not** valid at `/api/v1`. An audience mismatch means the token was minted for a different resource — reject it (confused-deputy defense).
5. Check `exp`. Tokens live ≤15 minutes by default (hard-capped at 1 hour), so clock skew tolerance should be small (≤60s).
6. Read authority from the `scope` claim (space-delimited) and tenant from `org` — never infer either from anything else in the request.

**Revocation caveat:** the platform additionally checks, on every request, that the key or client the token was minted from (its `cid` claim) is still active and un-rotated, and that its owner is not banned — an external verifier cannot see either. A signature-valid, unexpired token you verify locally may already be dead on the platform. This is by design and is why the TTL is short: treat your local verification as "valid for at most `exp`", and for high-stakes actions re-check live via `GET /api/v1/me` with the presented token.

## 6. Revocation & incident response

The kill switches, from narrowest to widest — all take effect on the next request (there is no cache to drain):

| To stop… | Do | Effect |
| --- | --- | --- |
| One API key | `DELETE /api/v1/me/api-keys/{id}` (owner) or `/api/v1/admin/api-keys/{id}` (admin), or **rotate** it | Key rejected immediately; rotation replaces it atomically. **Outstanding JWTs minted from the key die on their next request** (`401 credential_revoked`) — every token carries a `cid` claim naming its source credential and the resolver re-reads that row each time |
| One OAuth client | `DELETE /api/v1/admin/oauth-clients/{id}`, or rotate its secret | Client can no longer mint tokens, and its outstanding JWTs die on their next request — revoke kills them all; a secret rotation kills those minted **before** the rotation (`iat` precedes `secret_rotated_at`) |
| Outstanding JWTs of a compromised principal | Revoke/rotate the credential (above), or **ban the service user** (Administrator → Users → Ban) | Both take effect on the next bearer request: the credential check retires that credential's tokens; the ban check (AUTH-1) retires every token of the principal, and `unban` restores access with no extra bookkeeping |
| One agent (MCP) | **Administrator → Agents → Revoke** (revokes the client) | Agent's tokens stop minting and outstanding ones die on their next request |
| Everything, one tenant | Deactivate the org / remove the service users' memberships | Token minting re-checks active membership of the bound org |
| Everything, platform-wide | Unset `API_KEYS_ENABLED` / `API_JWT_ENABLED` / `MCP_ENABLED` and redeploy | The surfaces go dark (`401`) regardless of stored credentials |

Notes for a suspected credential leak:

- **Rotate first, investigate second** — rotation is atomic and non-disruptive if the third party can pick up the new secret quickly; revocation is the harder stop.
- JWTs cannot be un-issued individually, but revoking or rotating the credential they were minted from retires them on their next request, and so does banning the owner; they expire within minutes anyway (a token minted from an API key also never outlives that key's `expires_at`). A shared service user (the anti-pattern [§3](#3-operator-playbook--granting-access-safely) step 1 exists to prevent) is therefore no longer a reason to wait out the TTL — rotate the one credential that leaked.
- The audit log's `token.issued` events tell you exactly which tokens were minted from a compromised credential and when; `last_used_ip` on the key tells you from where.
- Report suspected **platform** vulnerabilities via [SECURITY.md](../SECURITY.md) — privately, not in a public issue.

## 7. Third-party AI agents (MCP)

The MCP gateway (`/api/mcp`) is the same machine API behind a protocol adapter — every tool call passes the same `permission ∩ scope` guard, so an agent can never do anything the raw API would refuse ([API Reference §11](./api.md#11-mcp-agent-gateway-model-context-protocol), [Design: MCP Agent Gateway](./design-mcp-agent-gateway.md)). Securing third-party agents:

- **Registration is gated twice.** The gateway (`MCP_ENABLED`) and self-registration (`MCP_REGISTRATION_ENABLED`) are independent dark-by-default switches. With registration off, agents only exist if an admin creates the OAuth client deliberately.
- **Self-registered agents start powerless.** Registration provisions a service account and a **zero-scope** client; in the default `approval` mode the account is parked `pending_approval` and cannot even mint a token. In `open` mode it can authenticate but every tool returns `403` until scopes are granted. Either way, "registered" ≠ "authorized".
- **Abuse is bounded** by a per-IP + deployment-wide rate limit on registration — both buckets live in Postgres (`app_rate_limits`), so the floor is one floor across every instance or serverless invocation, not one per process — a per-org quota on **self-registered** agents (`MCP_REGISTRATION_MAX_PER_ORG` — only active clients whose service account holds an active `mcp` membership count, and admin-created clients never do, so neither side can lock the other out), checked **atomically** with the insert under a per-org advisory lock so concurrent requests cannot overshoot it, and a scheduled **reaper** that expires still-pending self-registrations after `MCP_REGISTRATION_PENDING_TTL_DAYS` (default 7) so junk cannot bury a legitimate agent in the console. Note the mode trade-off: in `approval` mode a junk registration is pending — it never consumes quota and the reaper clears it; in `open` mode every registration is active at once and **does** consume quota (the quota is then the hard ceiling on the public endpoint by design), so prefer `approval` mode anywhere the endpoint is reachable by strangers.
- **A caller cannot pick the tenant.** With `MCP_REGISTRATION_DEFAULT_ORG` set, a request naming a different `organization` is refused (same generic error as an unknown org) unless that org is on `MCP_REGISTRATION_ALLOWED_ORGS`. Only a deployment with neither configured accepts any active org — the deliberate open multi-tenant mode.
- **Audience-bound (RFC 8707).** A JWT drives the gateway only if it was requested for it: `resource=<origin>/api/mcp` at the token endpoint mints `aud=<origin>/api/mcp`, which `/api/mcp` requires and `/api/v1` refuses (`401 invalid_token`); a token minted for general `/api/v1` use is refused at the gateway the same way, with a `WWW-Authenticate` challenge naming the resource to request. Both resources are advertised in the discovery metadata (`resource` in the protected-resource document, `resources_supported` in the authorization-server document). `MCP_AUDIENCE_GRACE=1` widens the gateway to legacy v1-audience tokens for a migration window — unset it once every agent has moved. API keys are not audience-bound. When a tool call reaches `/api/v1`, the gateway (which is also the authorization server) exchanges the MCP-audience token for a ≤60 s v1-audience one with the same subject, scopes, org and source credential — narrowing, never widening, and still `permission ∩ scope`-bounded.
- **Govern agents like the service users they are.** Approve, set the scope ceiling, and revoke from **Administrator → Agents** ([Admin Manager §8.13](./admin-manager.md#813-mcp-agents)); remember the intersection rule — a granted scope only becomes effective where the agent's service account also holds the matching permission via a role.
- **Scope agents for reads first.** Tool descriptions carry their required scope, and `GET` tools are marked read-only. Grant write/destructive scopes to an agent only with the same scrutiny you'd give a human admin — an LLM-driven client can be steered by the content it processes (prompt injection), so its blast radius must be its scope ceiling, not its good intentions.

## 8. Third-party and satellite web apps

For a web application on one of your subdomains that should reuse platform sign-in, the load-bearing decision is the **trust boundary** — full guide: [Satellite Apps — Integration Guide](./integration-satellite-apps.md); design rationale: [Design: Satellite Apps](./design-satellite-apps.md).

- **Third-party or mixed-trust app → SSO handoff (Options A/B).** The satellite keeps its **own** session store, cookie (scoped to its own subdomain), and `BETTER_AUTH_SECRET`; there is **no shared secret at all** — handoff tokens are EdDSA-signed by the primary's private key and the satellite verifies them against the primary's public JWKS (`/api/sso/jwks.json`), and the only bridge is a **single-use, audience-bound, ≤60-second** token. A compromised satellite holds no signing capability and can impersonate no one on the primary or on sibling apps.
- **Option C (shared `auth` schema) is for first-party, co-trusted apps only.** It shares the parent-domain session cookie and the full `BETTER_AUTH_SECRET` — an XSS or subdomain takeover on *any* app in the fleet then impersonates users everywhere. Never give this model to a third party.
- **The primary stays in control** either way: satellites are registered as enterprise apps (origin + audience allow-listed via `SSO_ALLOWED_ORIGIN_SUFFIXES`), handoff tokens are minted only for registered audiences, and access is revocable centrally.
- A satellite that also needs to *call the machine API* is just another API client — give it its own credential per [§2](#2-which-credential-should-a-third-party-get); never let it reuse SSO artifacts as API credentials (different keys, different algorithms, different audiences — deliberately).

## 9. Transport & platform hardening

Baseline expectations around the credential layer:

- **TLS everywhere.** Bearer credentials are only as safe as the channel; the app also ships CSP/HSTS-class security headers via `next.config.mjs` — keep them when forking.
- **The origin guard protects the cookie surface, not bearer.** Cookie-session mutations require a trusted `Origin` (CSRF defense); bearer requests are non-ambient so it deliberately does not apply ([design §8.2](./design-api-keys-and-tokens.md#82-the-guard--requireapipermission)).
- **Set `TRUSTED_PROXY_COUNT` correctly** ([Configuration](./configuration.md#reverse-proxy--limits)). Rate-limit keys derive the client IP a fixed number of hops from the right of `X-Forwarded-For`; a wrong value lets an attacker spoof their IP into someone else's bucket (too high) or rate-limits your proxy instead of clients (too low).
- **The token endpoint is defended in depth**: a global floor plus a per-trusted-IP bucket before any verification, and a per-credential bucket only once the credential has verified — so knowing a victim's public `client_id` cannot lock that client out, rotating ids cannot escape the IP bucket, and spoofed forwarded headers still hit the floor ([design §10.2](./design-api-keys-and-tokens.md#102-rate-limiting)). The two pre-auth buckets are **shared across instances** (a Postgres-backed bucket, `app_rate_limits`), so the floor really is deployment-wide on a multi-instance or serverless deployment; if the database is unreachable they fall back to a per-instance bucket and log a warning (`devresponsekit_rate_limit_shared_fallbacks_total` counts it) rather than failing open. The per-credential bucket is in-process — its fan-out is bounded by the credentials the caller holds.
- **Keep the JWT signing key out of the app's blast radius**: `API_JWT_PRIVATE_KEY` is an env/KMS-referenced Ed25519 private JWK; only its public half is ever served. Rotate it with the two-key overlap window ([design §6.4](./design-api-keys-and-tokens.md#64-key-rotation--verify-only-window)).

## 10. Checklists

**Before enabling the machine API in production**

- [ ] Decide which paths you need (`API_KEYS_ENABLED`, `API_JWT_ENABLED`) — leave the rest dark
- [ ] Generate the Ed25519 signing key into your secret store; set `API_JWT_ISSUER`/`API_JWT_AUDIENCE` deliberately
- [ ] Set `TRUSTED_PROXY_COUNT` for your proxy/CDN topology
- [ ] Confirm `API_KEY_ENV_TAG` (`live`/`test`) matches the environment
- [ ] Know who holds `admin.apikeys.*`, `admin.clients.*`, and `admin.audit.read`

**Per third party you onboard**

- [ ] Dedicated service user, bound to the right org, granted a minimal role
- [ ] Credential scoped to an explicit list (no wildcards), with an expiry
- [ ] Client-credentials + JWT for external parties where practical
- [ ] Rotation cadence agreed; their secret storage confirmed (secret manager, not code)
- [ ] Kill-switch rehearsed: you know which row in [§6](#6-revocation--incident-response) applies

**Per third-party application you host (satellite)**

- [ ] Handoff model (A/B), not the shared schema, unless first-party and co-trusted
- [ ] Registered as an enterprise app; subdomain covered by `SSO_ALLOWED_ORIGIN_SUFFIXES`
- [ ] The satellite has **no** `SSO_HANDOFF_PRIVATE_KEY` (issuer only); the primary's key is distinct from its `API_JWT_PRIVATE_KEY` and per environment
- [ ] Its own `DATABASE_URL` + `BETTER_AUTH_SECRET` (A/B); machine-API credential separate from SSO artifacts

---

_See also: [API Reference & Clients](./api.md) · [Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md) · [Design: MCP Agent Gateway](./design-mcp-agent-gateway.md) · [Satellite Apps — Integration Guide](./integration-satellite-apps.md) · [SECURITY.md](../SECURITY.md)._
