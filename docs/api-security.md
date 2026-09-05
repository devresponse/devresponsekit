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

**Never** hand a third party: a human user's credentials, a cookie session, the `BETTER_AUTH_SECRET`, the `SSO_HANDOFF_JWT_SECRET`, or a wildcard-scoped credential you wouldn't grant them permission-by-permission.

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
4. Check `iss` equals the platform's configured issuer (`API_JWT_ISSUER`, default its `BETTER_AUTH_URL`) and `aud` equals the platform audience (`devresponse-api` by default). An audience mismatch means the token was minted for a different resource — reject it (confused-deputy defense).
5. Check `exp`. Tokens live ≤15 minutes by default (hard-capped at 1 hour), so clock skew tolerance should be small (≤60s).
6. Read authority from the `scope` claim (space-delimited) and tenant from `org` — never infer either from anything else in the request.

**Revocation caveat:** the platform additionally checks each token's `jti` against its own denylist and its owner's live ban status on every request — an external verifier cannot see either. A signature-valid, unexpired token you verify locally may already be dead on the platform. This is by design and is why the TTL is short: treat your local verification as "valid for at most `exp`", and for high-stakes actions re-check live via `GET /api/v1/me` with the presented token.

## 6. Revocation & incident response

The kill switches, from narrowest to widest — all take effect on the next request (there is no cache to drain):

| To stop… | Do | Effect |
| --- | --- | --- |
| One API key | `DELETE /api/v1/me/api-keys/{id}` (owner) or `/api/v1/admin/api-keys/{id}` (admin), or **rotate** it | Key rejected immediately; rotation replaces it atomically |
| One OAuth client | `DELETE /api/v1/admin/oauth-clients/{id}`, or rotate its secret | Client can no longer mint tokens |
| Outstanding JWTs of a compromised principal | **Ban the service user** (Administrator → Users → Ban) | The resolver re-checks ban status on **every** bearer request (AUTH-1), so even signature-valid, unexpired JWTs stop working instantly; `unban` restores access with no extra bookkeeping |
| One agent (MCP) | **Administrator → Agents → Revoke** (revokes the client) | Agent's tokens stop minting; outstanding ones die with the service-user ban as above |
| Everything, one tenant | Deactivate the org / remove the service users' memberships | Token minting re-checks active membership of the bound org |
| Everything, platform-wide | Unset `API_KEYS_ENABLED` / `API_JWT_ENABLED` / `MCP_ENABLED` and redeploy | The surfaces go dark (`401`) regardless of stored credentials |

Notes for a suspected credential leak:

- **Rotate first, investigate second** — rotation is atomic and non-disruptive if the third party can pick up the new secret quickly; revocation is the harder stop.
- JWTs cannot be un-issued, but they die with the owner's ban and expire within minutes anyway. If you cannot ban the owner (shared service user — which is the anti-pattern [§3](#3-operator-playbook--granting-access-safely) step 1 exists to prevent), rotate the minting credential and wait out the TTL.
- The audit log's `token.issued` events tell you exactly which tokens were minted from a compromised credential and when; `last_used_ip` on the key tells you from where.
- Report suspected **platform** vulnerabilities via [SECURITY.md](../SECURITY.md) — privately, not in a public issue.

## 7. Third-party AI agents (MCP)

The MCP gateway (`/api/mcp`) is the same machine API behind a protocol adapter — every tool call passes the same `permission ∩ scope` guard, so an agent can never do anything the raw API would refuse ([API Reference §11](./api.md#11-mcp-agent-gateway-model-context-protocol), [Design: MCP Agent Gateway](./design-mcp-agent-gateway.md)). Securing third-party agents:

- **Registration is gated twice.** The gateway (`MCP_ENABLED`) and self-registration (`MCP_REGISTRATION_ENABLED`) are independent dark-by-default switches. With registration off, agents only exist if an admin creates the OAuth client deliberately.
- **Self-registered agents start powerless.** Registration provisions a service account and a **zero-scope** client; in the default `approval` mode the account is parked `pending_approval` and cannot even mint a token. In `open` mode it can authenticate but every tool returns `403` until scopes are granted. Either way, "registered" ≠ "authorized".
- **Abuse is bounded** by a per-IP + deployment-wide rate limit on registration and a per-org agent quota (`MCP_REGISTRATION_MAX_PER_ORG`; only **active** clients count, so junk registrations can't exhaust an org's slots).
- **One audience today.** The gateway accepts any valid bearer minted for the deployment audience — there is no separate MCP-only `aud` yet (RFC 8707 resource indicators are a planned refinement), so a token minted for general `/api/v1` use can also drive MCP tools. Its authority is still bounded by `permission ∩ scope`; just don't assume "not an MCP token" is a boundary.
- **Govern agents like the service users they are.** Approve, set the scope ceiling, and revoke from **Administrator → Agents** ([Admin Manager §8.13](./admin-manager.md#813-mcp-agents)); remember the intersection rule — a granted scope only becomes effective where the agent's service account also holds the matching permission via a role.
- **Scope agents for reads first.** Tool descriptions carry their required scope, and `GET` tools are marked read-only. Grant write/destructive scopes to an agent only with the same scrutiny you'd give a human admin — an LLM-driven client can be steered by the content it processes (prompt injection), so its blast radius must be its scope ceiling, not its good intentions.

## 8. Third-party and satellite web apps

For a web application on one of your subdomains that should reuse platform sign-in, the load-bearing decision is the **trust boundary** — full guide: [Satellite Apps — Integration Guide](./integration-satellite-apps.md); design rationale: [Design: Satellite Apps](./design-satellite-apps.md).

- **Third-party or mixed-trust app → SSO handoff (Options A/B).** The satellite keeps its **own** session store, cookie (scoped to its own subdomain), and `BETTER_AUTH_SECRET`; the only shared secret is the HS256 handoff secret, and the only bridge is a **single-use, audience-bound, ≤60-second** token. A compromised satellite can impersonate no one on the primary or on sibling apps.
- **Option C (shared `auth` schema) is for first-party, co-trusted apps only.** It shares the parent-domain session cookie and the full `BETTER_AUTH_SECRET` — an XSS or subdomain takeover on *any* app in the fleet then impersonates users everywhere. Never give this model to a third party.
- **The primary stays in control** either way: satellites are registered as enterprise apps (origin + audience allow-listed via `SSO_ALLOWED_ORIGIN_SUFFIXES`), handoff tokens are minted only for registered audiences, and access is revocable centrally.
- A satellite that also needs to *call the machine API* is just another API client — give it its own credential per [§2](#2-which-credential-should-a-third-party-get); never let it reuse SSO artifacts as API credentials (different keys, different algorithms, different audiences — deliberately).

## 9. Transport & platform hardening

Baseline expectations around the credential layer:

- **TLS everywhere.** Bearer credentials are only as safe as the channel; the app also ships CSP/HSTS-class security headers via `next.config.mjs` — keep them when forking.
- **The origin guard protects the cookie surface, not bearer.** Cookie-session mutations require a trusted `Origin` (CSRF defense); bearer requests are non-ambient so it deliberately does not apply ([design §8.2](./design-api-keys-and-tokens.md#82-the-guard--requireapipermission)).
- **Set `TRUSTED_PROXY_COUNT` correctly** ([Configuration](./configuration.md#reverse-proxy--limits)). Rate-limit keys derive the client IP a fixed number of hops from the right of `X-Forwarded-For`; a wrong value lets an attacker spoof their IP into someone else's bucket (too high) or rate-limits your proxy instead of clients (too low).
- **The token endpoint is defended in depth**: a global floor plus a per-trusted-IP bucket before any verification, and a per-credential bucket only once the credential has verified — so knowing a victim's public `client_id` cannot lock that client out, rotating ids cannot escape the IP bucket, and spoofed forwarded headers still hit the floor ([design §10.2](./design-api-keys-and-tokens.md#102-rate-limiting)).
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
- [ ] `SSO_HANDOFF_JWT_SECRET` ≠ `BETTER_AUTH_SECRET`, and distinct per environment
- [ ] Its own `DATABASE_URL` + `BETTER_AUTH_SECRET` (A/B); machine-API credential separate from SSO artifacts

---

_See also: [API Reference & Clients](./api.md) · [Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md) · [Design: MCP Agent Gateway](./design-mcp-agent-gateway.md) · [Satellite Apps — Integration Guide](./integration-satellite-apps.md) · [SECURITY.md](../SECURITY.md)._
