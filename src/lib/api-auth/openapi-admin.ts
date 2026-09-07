/**
 * OpenAPI 3.1 document for the `/api/administrator/*` console API — the
 * basis for the committed internal admin SDK
 * (`pnpm openapi:export` → `docs/openapi-admin.json`, then `pnpm sdk:admin:generate`).
 *
 * This surface is NOT the public machine API (`/api/v1`, see `openapi.ts`).
 * It authenticates with the Better Auth **session cookie** — in which case
 * every mutation additionally requires an `Origin`/`Referer` header matching
 * a trusted origin (CSRF guard) — OR with a scope-bounded **bearer**
 * credential (API key / JWT), which `requireAdminPermission` accepts and
 * exempts from the origin guard (review #193). Errors use the admin envelope
 * `{ error, message, requestId }`. List endpoints share the
 * `{ items, page, pageSize, total, sort }` envelope; mutations mostly return
 * `{ ok: true, … }`. Responses are raw snake_case rows.
 *
 * Every admin route file must be modeled here: the route ⇄ spec parity test
 * (`tests/unit/api-route-spec-parity.test.ts`, review #192) fails CI for an
 * admin route without a path entry, and the source-derived test in
 * `tests/unit/api-openapi-admin.test.ts` (review #195) checks that every
 * `enforceRateLimit(` call site documents a 429 and every `allowedFilters`
 * entry is a documented `filter[...]` parameter.
 */
import { MCP_AGENT_STATUSES } from "@/lib/mcp/agents";
import {
  AUTH_POLICY_APPROVAL_MODES as AUTH_POLICY_APPROVAL_MODE_VALUES,
  AUTH_POLICY_METHODS as AUTH_POLICY_METHOD_VALUES,
} from "@/lib/validation/auth-policy";

type Obj = Record<string, unknown>;

const ref = (name: string): Obj => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj): Obj => ({ content: { "application/json": { schema } } });
const errRef = (name: string): Obj => ({ $ref: `#/components/responses/${name}` });
const paramRef = (name: string): Obj => ({ $ref: `#/components/parameters/${name}` });

const uuid = (): Obj => ({ type: "string", format: "uuid" });
const nullableString = (): Obj => ({ type: ["string", "null"] });
const dateTime = (nullable = false): Obj => ({
  type: nullable ? ["string", "null"] : "string",
  format: "date-time",
});
const stringArray = (): Obj => ({ type: "array", items: { type: "string" } });
const integer = (): Obj => ({ type: "integer" });
const boolean = (): Obj => ({ type: "boolean" });

/** `{ items, page, pageSize, total, sort }` envelope wrapping `itemName`. */
const listOf = (itemName: string): Obj => ({
  type: "object",
  properties: {
    items: { type: "array", items: ref(itemName) },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 200 },
    total: { type: "integer", minimum: 0 },
    sort: { type: "array", items: ref("SortSpec") },
  },
  required: ["items", "page", "pageSize", "total"],
});

const USER_STATUS = ["active", "pending_approval", "blocked", "suspended", "deactivated"];
const MEMBERSHIP_STATUS = ["active", "pending_approval", "blocked", "suspended"];
const CREDENTIAL_STATUS = ["active", "revoked"];
// Sourced from the shared, client-safe validation module so the spec's
// enums cannot drift from the schema + DB CHECK (they did: `invite_only`
// was added in 0008 but missed here). Spread into a mutable array because
// the OpenAPI builder treats these as plain JSON.
const AUTH_POLICY_METHODS = [...AUTH_POLICY_METHOD_VALUES];
const AUTH_POLICY_MODES = [...AUTH_POLICY_APPROVAL_MODE_VALUES];
// Same reasoning for the derived agent lifecycle status (review #192): the
// console filter, the SQL predicates and this enum share one definition.
const MCP_AGENT_STATUS = [...MCP_AGENT_STATUSES];

/**
 * The cookie the Better Auth session rides in. Better Auth prefixes the
 * cookie with `__Secure-` whenever `baseURL` is https (its `useSecureCookies`
 * default), so that is the production name; the bare name only appears on a
 * plain-http dev origin (review #196).
 */
export const ADMIN_SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";
export const ADMIN_SESSION_COOKIE_NAME_HTTP = "better-auth.session_token";

/** A path id parameter. */
const idParam = (name = "id", format: "uuid" | "string" = "uuid"): Obj => ({
  name,
  in: "path",
  required: true,
  schema: format === "uuid" ? uuid() : { type: "string" },
});

/** An exact-match `filter[<name>]` query parameter (repeatable). */
const filterParam = (
  name: string,
  description = "Exact-match filter; repeat for multiple values.",
): Obj => ({
  name,
  in: "query",
  required: false,
  explode: true,
  style: "form",
  schema: { type: "array", items: { type: "string" } },
  description,
});

/**
 * The two halves of a `filter[<name>][from]` / `[to]` ISO-8601 range filter
 * (`parseListQuery` range syntax, review #195).
 */
const rangeFilterParams = (name: string): Obj[] =>
  (["from", "to"] as const).map((bound) => ({
    name: `filter[${name}][${bound}]`,
    in: "query",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: `${bound === "from" ? "Inclusive lower" : "Inclusive upper"} bound of the \`${name}\` range (ISO-8601).`,
  }));

/** Shared list-query params for an endpoint. */
const listParams = (filters: string[] = [], q = true): Obj[] => {
  const out: Obj[] = [paramRef("Page"), paramRef("PageSize"), paramRef("Sort")];
  if (q) out.push(paramRef("Q"));
  for (const f of filters) out.push(filterParam(f));
  return out;
};

const okResp = (schemaName = "Ok"): Obj => ({ description: "OK", ...json(ref(schemaName)) });

/**
 * Outbox row metadata, shared by the list item and the detail schema. The
 * detail adds the rendered bodies; the list never carries them (review #221).
 */
const OUTBOX_ITEM_PROPERTIES: Record<string, Obj> = {
  id: uuid(),
  organization_id: { type: ["string", "null"], format: "uuid" },
  organization_slug: nullableString(),
  organization_name: nullableString(),
  template_key: nullableString(),
  to_email: { type: "string" },
  from_email: { type: "string" },
  subject: { type: "string" },
  status: { type: "string", enum: ["pending", "sent", "failed", "logged"] },
  provider: nullableString(),
  provider_message_id: nullableString(),
  error: nullableString(),
  related_better_auth_user_id: nullableString(),
  created_at: dateTime(),
  sent_at: dateTime(true),
};
const createdResp = (schemaName: string): Obj => ({
  description: "Created",
  ...json(ref(schemaName)),
});

// Every operation answers 401 for a missing/invalid credential before anything
// else — `requireAdminPermission` does it for all but one, and the guard-free
// `DELETE /users/{id}/impersonate` does it itself via `getCurrentSession()` —
// so 401 belongs on EVERY operation, not on none of them (review #195).
/** Standard error responses for a collection read (no `{id}` → no 404). */
const listErrors = (): Obj => ({
  "400": errRef("BadRequest"),
  "401": errRef("Unauthorized"),
  "403": errRef("Forbidden"),
});
/** Standard error responses for a read endpoint. */
const readErrors = (): Obj => ({
  "400": errRef("BadRequest"),
  "401": errRef("Unauthorized"),
  "403": errRef("Forbidden"),
  "404": errRef("NotFound"),
});
/** Standard error responses for a mutating endpoint. */
const writeErrors = (extra: Record<string, Obj> = {}): Obj => ({
  "400": errRef("BadRequest"),
  "401": errRef("Unauthorized"),
  "403": errRef("Forbidden"),
  "404": errRef("NotFound"),
  "409": errRef("Conflict"),
  "429": errRef("RateLimited"),
  ...extra,
});

export function buildAdminOpenApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "DevResponse Administrator API",
      version: "1.0.0",
      description:
        "Administrator console API (`/api/administrator`). Authenticate EITHER with the Better Auth " +
        "**session cookie** (send credentials with the request; every **mutation** then also requires " +
        "an `Origin` or `Referer` header matching a trusted origin — the CSRF guard — which a browser " +
        "sets itself and a server-side caller must add) OR with a **bearer** API key / JWT, whose " +
        "effective authority is the intersection of its scopes and the permissions of its owner and which " +
        "is exempt from the origin guard. The one exception is `DELETE /users/{id}/impersonate`, " +
        "which bypasses the permission guard by design and is therefore **cookie-session only** " +
        "(see that operation). Org admins are scoped to their own organization " +
        "(out-of-scope resources return 404, not 403). Errors use `{ error, message, requestId }`; " +
        "every response carries an `x-request-id` header.",
    },
    servers: [{ url: `${baseUrl}/api/administrator` }],
    // Two alternative requirements (OR), mirroring `resolveCaller`: a cookie
    // session, or a scope-bounded bearer credential (review #193). Operations
    // that do NOT run through `resolveCaller` must narrow this per-operation —
    // today that is only `DELETE /users/{id}/impersonate` (cookie-only).
    security: [{ cookieSession: [] }, { bearerAuth: [] }],
    // `x-permissions` is the per-group permission summary the generated
    // docs/api.md table prints (review #198); the per-operation key is in each
    // operation's summary / the route handler.
    tags: [
      {
        name: "Users",
        description: "User administration.",
        "x-permissions": "`admin.users.*` (per action)",
      },
      {
        name: "Roles",
        description: "Roles and their permissions.",
        "x-permissions": "`admin.roles.*`",
      },
      {
        name: "Permissions",
        description: "The permission catalog.",
        "x-permissions": "`admin.roles.read`, `admin.permissions.manage`",
      },
      {
        name: "Groups",
        description: "Organization groups (ADR-0002).",
        "x-permissions": "`admin.groups.*` (`.assign` for members and roles)",
      },
      {
        name: "Organizations",
        description: "Tenants and their members / provider bindings / sign-up policy.",
        "x-permissions": "`admin.orgs.*` (`/auth-settings/defaults`: + **superadmin**)",
      },
      {
        name: "Memberships",
        description: "User↔organization memberships.",
        "x-permissions": "`admin.orgs.read`",
      },
      {
        name: "Enterprise apps",
        description: "SSO application registry.",
        "x-permissions": "`admin.apps.*`",
      },
      {
        name: "API keys",
        description: "API-key governance.",
        "x-permissions": "`admin.apikeys.*`",
      },
      { name: "Email", description: "Outbox and templates.", "x-permissions": "`admin.email.*`" },
      {
        name: "MCP agents",
        description: "Self-registered MCP agents (OAuth clients with an `mcp` service membership).",
        "x-permissions": "`admin.clients.read` / `admin.clients.manage`",
      },
      { name: "Audit", description: "The audit log.", "x-permissions": "`admin.audit.read`" },
      {
        name: "Export",
        description: "CSV exports.",
        "x-permissions": "the exported resource's read permission",
      },
    ],
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: ADMIN_SESSION_COOKIE_NAME,
          description:
            "Better Auth session cookie. The name carries Better Auth's `__Secure-` prefix on any " +
            `https origin (production); only a plain-http dev origin uses the bare \`${ADMIN_SESSION_COOKIE_NAME_HTTP}\`. ` +
            "The value is the SIGNED cookie value exactly as a real browser session holds it — not a " +
            "session id or token from the `session` table, which Better Auth will reject. Browser " +
            'clients send it automatically (`credentials: "include"`); a server-side caller forwards ' +
            "the `Cookie` header and, on every mutation, adds a trusted `Origin` header (the CSRF guard).",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A DevResponse API key (`drk_…`) or a JWT minted at `POST /api/v1/auth/token`, in " +
            "`Authorization: Bearer …`. Accepted on every administrator operation that lists it " +
            "(all of them except `DELETE /users/{id}/impersonate`, which is cookie-only; both " +
            "credential paths are disabled by default: `API_KEYS_ENABLED` / `API_JWT_ENABLED`). The credential's " +
            "effective authority is `scopes ∩ owner permissions`: an operation needs the owner to hold " +
            "the permission AND the credential to carry a scope covering it (e.g. `admin.users.read`, " +
            "or a prefix scope such as `admin.users.*`), else `403 forbidden`. Bearer callers are " +
            "exempt from the `Origin` guard (a bearer cannot be attached by a cross-site page).",
        },
      },
      parameters: {
        Page: {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-indexed page number.",
        },
        PageSize: {
          name: "pageSize",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 200 },
          description: "Rows per page (clamped to 1–200).",
        },
        Sort: {
          name: "sort",
          in: "query",
          required: false,
          explode: true,
          style: "form",
          schema: { type: "array", items: { type: "string" } },
          description: "Sort directives as `field.asc` / `field.desc`.",
        },
        Q: {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Case-insensitive search.",
        },
      },
      responses: {
        BadRequest: { description: "Invalid request", ...json(ref("AdminError")) },
        Unauthorized: {
          description:
            "No session cookie and no bearer credential resolved (`unauthenticated`) — also the " +
            "answer for a revoked/expired bearer or a disabled credential path.",
          ...json(ref("AdminError")),
        },
        Forbidden: {
          description:
            "`forbidden`: the caller lacks the permission (or, for a bearer, a covering scope), " +
            "their account/membership is not active, or the action is out of their org scope. " +
            "`untrusted_origin`: a cookie-session MUTATION arrived without an `Origin`/`Referer` " +
            "header matching a trusted origin (CSRF guard; never returned to bearer callers).",
          ...json(ref("AdminError")),
        },
        NotFound: { description: "Not found (or out of org scope)", ...json(ref("AdminError")) },
        Conflict: { description: "Conflict", ...json(ref("AdminError")) },
        Unprocessable: {
          description: "Unprocessable — `invalid_scope` with the scopes the caller may not grant",
          ...json(ref("UnprocessableError")),
        },
        RateLimited: {
          description: "Too many requests (`rate_limited`); retry after `retryAfter` seconds",
          headers: {
            "Retry-After": {
              description: "Seconds to wait — the same value as the body's `retryAfter`.",
              schema: { type: "string" },
            },
          },
          ...json(ref("RateLimitedError")),
        },
      },
      schemas: {
        AdminError: {
          type: "object",
          description:
            "Administrator error envelope. `adminErrorResponse` may spread extra non-secret " +
            "fields for specific codes — see `RateLimitedError` / `UnprocessableError`.",
          properties: {
            error: { type: "string", description: "Machine-readable code." },
            message: { type: "string", description: "i18n message key." },
            requestId: { type: "string" },
          },
          required: ["error", "message", "requestId"],
          additionalProperties: true,
        },
        // Per-code envelopes (review #195): the 429 and 422 bodies carry fields
        // a client acts on, so they are modeled rather than hidden in
        // `additionalProperties`.
        RateLimitedError: {
          allOf: [
            ref("AdminError"),
            {
              type: "object",
              properties: {
                retryAfter: {
                  type: "integer",
                  minimum: 1,
                  description: "Seconds until the bucket refills enough to retry.",
                },
              },
              required: ["retryAfter"],
            },
          ],
        },
        UnprocessableError: {
          allOf: [
            ref("AdminError"),
            {
              type: "object",
              properties: {
                ungrantableScopes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Requested scopes outside the caller's own authority (permissions ∩ credential scopes).",
                },
              },
              required: ["ungrantableScopes"],
            },
          ],
        },
        SortSpec: {
          type: "object",
          properties: {
            field: { type: "string" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field", "direction"],
        },
        Ok: {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
        },
        OkId: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, id: uuid() },
          required: ["ok", "id"],
        },
        OkStatus: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, status: { type: "string" } },
          required: ["ok", "status"],
        },
        OkCount: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            updated: integer(),
            removed: integer(),
            added: integer(),
          },
          required: ["ok"],
        },

        // ---- Users -------------------------------------------------------
        UserListItem: {
          type: "object",
          properties: {
            id: uuid(),
            better_auth_user_id: { type: "string" },
            primary_email: { type: "string", format: "email" },
            display_name: nullableString(),
            status: { type: "string", enum: USER_STATUS },
            preferred_locale: { type: "string" },
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "primary_email", "status"],
        },
        UserDetail: {
          type: "object",
          properties: {
            id: uuid(),
            better_auth_user_id: { type: "string" },
            primary_email: { type: "string", format: "email" },
            display_name: nullableString(),
            status: { type: "string", enum: USER_STATUS },
            status_reason: nullableString(),
            preferred_locale: { type: "string" },
            created_at: dateTime(),
            updated_at: dateTime(),
            deactivated_at: dateTime(true),
            deactivated_by: { type: ["string", "null"], format: "uuid" },
            deactivated_reason: nullableString(),
          },
          required: ["id", "primary_email", "status"],
        },
        UserDetailEnvelope: {
          type: "object",
          properties: { user: ref("UserDetail") },
          required: ["user"],
        },
        UserList: listOf("UserListItem"),
        CreateUserRequest: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8, maxLength: 128 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            role: { type: "string", enum: ["admin", "user"] },
            initialAppStatus: { type: "string", enum: ["active", "pending_approval"] },
            preferredLocale: { type: "string", minLength: 2, maxLength: 10 },
          },
          required: ["email", "password"],
        },
        UserCreated: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            id: uuid(),
            better_auth_user_id: { type: "string" },
            primary_email: { type: "string", format: "email" },
            status: { type: "string", enum: USER_STATUS },
          },
          required: ["ok", "id"],
        },
        UpdateUserRequest: {
          type: "object",
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            preferredLocale: { type: "string", minLength: 2, maxLength: 10 },
          },
        },
        ReasonRequest: {
          type: "object",
          properties: { reason: { type: "string", maxLength: 500 } },
        },
        UserStatusRequest: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["approve", "block", "suspend", "reactivate"] },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["action"],
        },
        SetPasswordRequest: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "set" },
                password: { type: "string", minLength: 8, maxLength: 128 },
              },
              required: ["mode", "password"],
            },
            {
              type: "object",
              properties: {
                mode: { const: "reset_email" },
                redirectTo: { type: "string", format: "uri" },
              },
              required: ["mode"],
            },
          ],
        },
        SetRoleRequest: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["admin", "user"] },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["role"],
        },
        BanRequest: {
          type: "object",
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 500 },
            expiresInSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
          },
          required: ["reason"],
        },
        // A PROJECTION of the Better Auth session row (review #67/#194): the
        // raw `token` (the bearer credential of that session) is never
        // returned; `id` is what `DELETE …/sessions/{sessionId}` takes.
        SessionItem: {
          type: "object",
          description:
            "One active Better Auth session, projected to non-secret metadata. The session token is " +
            "never exposed; revoke by `id`.",
          properties: {
            id: { type: "string", description: "Session id — the `sessionId` path parameter." },
            createdAt: dateTime(),
            updatedAt: dateTime(),
            expiresAt: dateTime(),
            ipAddress: nullableString(),
            userAgent: nullableString(),
            impersonatedBy: {
              type: ["string", "null"],
              description:
                "Better Auth user id of the impersonating admin, when this is an impersonation session.",
            },
          },
          required: [
            "id",
            "createdAt",
            "updatedAt",
            "expiresAt",
            "ipAddress",
            "userAgent",
            "impersonatedBy",
          ],
          additionalProperties: false,
        },
        SessionList: {
          type: "object",
          properties: { sessions: { type: "array", items: ref("SessionItem") } },
          required: ["sessions"],
        },
        MembershipListItem: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: uuid(),
            organization_slug: { type: "string" },
            organization_name: { type: "string" },
            status: { type: "string", enum: MEMBERSHIP_STATUS },
            source_provider: nullableString(),
            provider_organization_key: nullableString(),
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "organization_id", "status"],
        },
        MembershipList: listOf("MembershipListItem"),
        AddMembershipRequest: {
          type: "object",
          properties: {
            organizationId: uuid(),
            status: { type: "string", enum: MEMBERSHIP_STATUS },
          },
          required: ["organizationId"],
        },
        UpdateMembershipsRequest: {
          type: "object",
          properties: {
            membershipIds: { type: "array", items: uuid(), minItems: 1 },
            status: { type: "string", enum: MEMBERSHIP_STATUS },
          },
          required: ["membershipIds", "status"],
        },
        DeleteMembershipsRequest: {
          type: "object",
          properties: { membershipIds: { type: "array", items: uuid(), minItems: 1 } },
          required: ["membershipIds"],
        },
        AppRoleAssignment: {
          type: "object",
          properties: {
            role_id: uuid(),
            role_key: { type: "string" },
            role_name: { type: "string" },
            organization_id: { type: ["string", "null"], format: "uuid" },
            organization_name: nullableString(),
            created_at: dateTime(),
          },
          required: ["role_id", "role_key"],
        },
        AppRoleAssignments: {
          type: "object",
          properties: { assignments: { type: "array", items: ref("AppRoleAssignment") } },
          required: ["assignments"],
        },
        AppRoleRef: {
          type: "object",
          properties: { roleId: uuid(), organizationId: uuid() },
          required: ["roleId", "organizationId"],
        },
        UserGroupRef: { type: "object", properties: { groupId: uuid() }, required: ["groupId"] },
        UserGroups: {
          type: "object",
          properties: {
            groups: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: uuid(),
                  organization_id: uuid(),
                  key: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
          },
          required: ["groups"],
        },
        BulkUserRequest: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "approve",
                "block",
                "suspend",
                "reactivate",
                "ban",
                "unban",
                "soft_delete",
                "restore",
              ],
            },
            // Mirrors `bulkSchema` in users/bulk/route.ts (review #195): a
            // non-empty capped id list, or `"*"` for "every user matching
            // `filters`"; both objects are Zod `.strict()`. Expressed as a
            // 3.1 multi-type rather than `oneOf`: typescript-fetch 7.12
            // emits an uncompilable model for a `oneOf` of primitives.
            ids: {
              type: ["array", "string"],
              items: uuid(),
              minItems: 1,
              maxItems: 500,
              description:
                "1–500 app user ids, or the string `*` (the only accepted string) to select by `filters`.",
            },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            expiresInSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
            filters: {
              type: "object",
              description: 'Selection filters for `ids: "*"` (ignored for an explicit id list).',
              properties: {
                // Zod: `z.union([z.string(), z.array(z.string())])` — same
                // multi-type encoding as `ids` (see above). typescript-fetch
                // types a multi-type by its FIRST entry, so `array` leads to
                // keep the generated client's `Array<string>`.
                status: {
                  type: ["array", "string"],
                  items: { type: "string" },
                  description: "A list of statuses, or one status as a bare string.",
                },
                q: { type: "string", minLength: 1, maxLength: 200 },
              },
              additionalProperties: false,
            },
          },
          required: ["action", "ids"],
          additionalProperties: false,
        },
        BulkUserResult: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            action: { type: "string" },
            attempted: integer(),
            succeeded: integer(),
            failed: integer(),
            results: {
              type: "array",
              items: {
                type: "object",
                properties: { ok: boolean(), appUserId: uuid(), error: { type: "string" } },
                required: ["ok", "appUserId"],
              },
            },
          },
          required: ["ok", "action", "attempted", "succeeded", "failed", "results"],
        },

        // ---- Roles / permissions / groups -------------------------------
        RoleListItem: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            key: { type: "string" },
            name: { type: "string" },
            description: nullableString(),
            created_at: dateTime(),
            permission_count: integer(),
            member_count: integer(),
          },
          required: ["id", "key", "name"],
        },
        RoleList: listOf("RoleListItem"),
        RoleDetail: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            key: { type: "string" },
            name: { type: "string" },
            description: nullableString(),
            created_at: dateTime(),
            permission_count: integer(),
            member_count: integer(),
            permissions: stringArray(),
          },
          required: ["id", "key", "name", "permissions"],
        },
        RoleDetailEnvelope: {
          type: "object",
          properties: { role: ref("RoleDetail") },
          required: ["role"],
        },
        CreateRoleRequest: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-zA-Z0-9_.\\-:]+$" },
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 1000 },
            organizationId: { type: ["string", "null"], format: "uuid" },
          },
          required: ["key", "name"],
        },
        UpdateRoleRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: ["string", "null"], maxLength: 1000 },
          },
        },
        KeyCreated: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, id: uuid(), key: { type: "string" } },
          required: ["ok", "id", "key"],
        },
        IdsRequest: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 },
          },
          required: ["ids"],
        },
        PermissionsResult: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, permissions: stringArray() },
          required: ["ok", "permissions"],
        },
        PermissionsList: {
          type: "object",
          properties: { permissions: stringArray() },
          required: ["permissions"],
        },
        RoleMemberItem: {
          type: "object",
          properties: {
            app_user_id: uuid(),
            primary_email: { type: "string" },
            display_name: nullableString(),
            status: { type: "string" },
            organization_id: { type: ["string", "null"], format: "uuid" },
            organization_name: nullableString(),
            created_at: dateTime(),
          },
          required: ["app_user_id", "primary_email"],
        },
        RoleMemberList: listOf("RoleMemberItem"),
        PermissionListItem: {
          type: "object",
          properties: {
            id: uuid(),
            key: { type: "string" },
            description: nullableString(),
            used_by_role_count: integer(),
          },
          required: ["id", "key"],
        },
        PermissionList: listOf("PermissionListItem"),
        CreatePermissionRequest: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-zA-Z0-9_.\\-:]+$" },
            description: { type: "string", maxLength: 1000 },
          },
          required: ["key"],
        },
        UpdatePermissionRequest: {
          type: "object",
          properties: { description: { type: ["string", "null"], maxLength: 1000 } },
          required: ["description"],
        },
        GroupListItem: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: uuid(),
            key: { type: "string" },
            name: { type: "string" },
            description: nullableString(),
            created_at: dateTime(),
            role_count: integer(),
            member_count: integer(),
          },
          required: ["id", "organization_id", "key", "name"],
        },
        GroupList: listOf("GroupListItem"),
        GroupDetailEnvelope: {
          type: "object",
          properties: { group: ref("GroupListItem") },
          required: ["group"],
        },
        CreateGroupRequest: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-zA-Z0-9_.\\-:]+$" },
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 1000 },
            organizationId: uuid(),
          },
          required: ["key", "name"],
        },
        UpdateGroupRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: ["string", "null"], maxLength: 1000 },
          },
        },
        GroupMemberItem: {
          type: "object",
          properties: {
            app_user_id: uuid(),
            primary_email: { type: "string" },
            display_name: nullableString(),
            status: { type: "string" },
            created_at: dateTime(),
          },
          required: ["app_user_id", "primary_email"],
        },
        GroupMemberList: listOf("GroupMemberItem"),
        AppUserIdsRequest: {
          type: "object",
          properties: { appUserIds: { type: "array", items: uuid(), minItems: 1, maxItems: 500 } },
          required: ["appUserIds"],
        },
        GroupRoleIdsRequest: {
          type: "object",
          properties: { roleIds: { type: "array", items: uuid(), minItems: 1, maxItems: 500 } },
          required: ["roleIds"],
        },
        GroupRolesResult: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            roleIds: { type: "array", items: uuid() },
          },
          required: ["ok", "roleIds"],
        },
        GroupRoles: {
          type: "object",
          properties: {
            roles: {
              type: "array",
              items: {
                type: "object",
                properties: { id: uuid(), key: { type: "string" }, name: { type: "string" } },
              },
            },
          },
          required: ["roles"],
        },

        // ---- Organizations / memberships --------------------------------
        OrganizationListItem: {
          type: "object",
          properties: {
            id: uuid(),
            slug: { type: "string" },
            name: { type: "string" },
            status: { type: "string" },
            is_default: boolean(),
            created_at: dateTime(),
            member_count: integer(),
          },
          required: ["id", "slug", "name"],
        },
        OrganizationList: listOf("OrganizationListItem"),
        OrganizationDetail: {
          type: "object",
          properties: {
            id: uuid(),
            slug: { type: "string" },
            name: { type: "string" },
            status: { type: "string" },
            is_default: boolean(),
            created_at: dateTime(),
            updated_at: dateTime(),
            member_count: integer(),
            binding_count: integer(),
            role_count: integer(),
          },
          required: ["id", "slug", "name"],
        },
        CreateOrganizationRequest: {
          type: "object",
          properties: {
            slug: { type: "string", minLength: 1, maxLength: 64 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            isDefault: boolean(),
          },
          required: ["slug", "name"],
        },
        UpdateOrganizationRequest: {
          type: "object",
          properties: {
            slug: { type: "string", minLength: 1, maxLength: 64 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", enum: ["active", "pending", "suspended", "archived"] },
            isDefault: boolean(),
          },
        },
        OrgMemberItem: {
          type: "object",
          properties: {
            id: uuid(),
            app_user_id: uuid(),
            user_display_name: { type: "string" },
            status: { type: "string", enum: MEMBERSHIP_STATUS },
            source_provider: nullableString(),
            provider_organization_key: nullableString(),
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "app_user_id", "status"],
        },
        OrgMemberList: listOf("OrgMemberItem"),
        AddOrgMemberRequest: {
          type: "object",
          properties: { appUserId: uuid(), status: { type: "string", enum: MEMBERSHIP_STATUS } },
          required: ["appUserId"],
        },
        ProviderBindingItem: {
          type: "object",
          properties: {
            id: uuid(),
            provider: { type: "string" },
            provider_organization_key: { type: "string" },
            display_name: { type: "string" },
            created_at: dateTime(),
          },
          required: ["id", "provider", "provider_organization_key"],
        },
        ProviderBindingList: listOf("ProviderBindingItem"),
        AddProviderBindingRequest: {
          type: "object",
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 64 },
            providerOrganizationKey: { type: "string", minLength: 1, maxLength: 255 },
            displayName: { type: "string", maxLength: 200 },
          },
          required: ["provider", "providerOrganizationKey"],
        },
        DeleteBindingsRequest: {
          type: "object",
          properties: { bindingIds: { type: "array", items: uuid(), minItems: 1 } },
          required: ["bindingIds"],
        },
        // Organization invitations (0008). Token hashes are never exposed.
        InvitationItem: {
          type: "object",
          properties: {
            id: uuid(),
            email: { type: "string" },
            status: { type: "string", enum: ["pending", "accepted", "revoked", "expired"] },
            role_id: { type: ["string", "null"], format: "uuid" },
            role_name: nullableString(),
            invited_by_display_name: nullableString(),
            expires_at: dateTime(),
            accepted_at: dateTime(true),
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "email", "status", "expires_at"],
        },
        InvitationList: listOf("InvitationItem"),
        CreateInvitationRequest: {
          type: "object",
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            roleId: {
              type: ["string", "null"],
              format: "uuid",
              description: "Optional app role granted on acceptance; must belong to this org.",
            },
          },
          required: ["email"],
        },
        InvitationCreated: {
          type: "object",
          properties: { ok: boolean(), id: uuid(), expiresAt: dateTime() },
          required: ["ok", "id", "expiresAt"],
        },
        InvitationResent: {
          type: "object",
          properties: { ok: boolean(), expiresAt: dateTime() },
          required: ["ok", "expiresAt"],
        },
        // Signup policy (0007). Deliberately camelCase (not a raw row): the
        // response mirrors the PATCH request's field names exactly, since an
        // org row is a COMPLETE policy round-tripped through the form.
        AuthPolicySettings: {
          type: ["object", "null"],
          description:
            "The raw policy override row; null when the organization inherits the platform default.",
          properties: {
            organizationId: { type: ["string", "null"], format: "uuid" },
            requireEmailVerification: boolean(),
            signupApprovalMode: { type: "string", enum: AUTH_POLICY_MODES },
            allowedAuthMethods: {
              type: ["array", "null"],
              items: { type: "string", enum: AUTH_POLICY_METHODS },
              description: "null = every enabled auth method is accepted.",
            },
            autoApproveEmailDomains: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "Lowercased domains; null = no domain auto-approval.",
            },
            updatedAt: dateTime(true),
          },
          required: ["requireEmailVerification", "signupApprovalMode"],
        },
        AuthPolicyEffective: {
          type: "object",
          description: "The resolved policy that actually governs sign-ups for this scope.",
          properties: {
            requireEmailVerification: boolean(),
            signupApprovalMode: { type: "string", enum: AUTH_POLICY_MODES },
            allowedAuthMethods: {
              type: ["array", "null"],
              items: { type: "string", enum: AUTH_POLICY_METHODS },
            },
            autoApproveEmailDomains: { type: ["array", "null"], items: { type: "string" } },
            source: {
              type: "string",
              enum: ["organization", "platform_default", "fail_closed"],
            },
          },
          required: ["requireEmailVerification", "signupApprovalMode", "source"],
        },
        AuthPolicyEnvelope: {
          type: "object",
          properties: {
            ok: boolean(),
            settings: ref("AuthPolicySettings"),
            effective: ref("AuthPolicyEffective"),
          },
          required: ["ok"],
        },
        UpdateAuthPolicyRequest: {
          type: "object",
          description:
            "A COMPLETE policy — there is no partial update; PATCH creates or replaces the row.",
          properties: {
            requireEmailVerification: boolean(),
            signupApprovalMode: { type: "string", enum: AUTH_POLICY_MODES },
            allowedAuthMethods: {
              type: ["array", "null"],
              items: { type: "string", enum: AUTH_POLICY_METHODS },
              maxItems: 4,
            },
            autoApproveEmailDomains: {
              type: ["array", "null"],
              items: { type: "string", minLength: 1, maxLength: 255 },
              maxItems: 50,
            },
          },
          required: [
            "requireEmailVerification",
            "signupApprovalMode",
            "allowedAuthMethods",
            "autoApproveEmailDomains",
          ],
        },
        GlobalMembershipItem: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: uuid(),
            organization_slug: { type: "string" },
            organization_name: { type: "string" },
            app_user_id: uuid(),
            user_display_name: { type: "string" },
            status: { type: "string", enum: MEMBERSHIP_STATUS },
            source_provider: nullableString(),
            provider_organization_key: nullableString(),
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "organization_id", "app_user_id", "status"],
        },
        GlobalMembershipList: listOf("GlobalMembershipItem"),

        // ---- Enterprise apps --------------------------------------------
        EnterpriseAppItem: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: nullableString(),
            origin: { type: "string", format: "uri" },
            subdomain: { type: "string" },
            sso_audience: { type: "string" },
            status: { type: "string" },
            sort_order: integer(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            organization_slug: nullableString(),
            created_at: dateTime(),
          },
          required: ["id", "label", "origin", "subdomain", "sso_audience"],
        },
        EnterpriseAppList: listOf("EnterpriseAppItem"),
        EnterpriseAppDetail: {
          allOf: [
            ref("EnterpriseAppItem"),
            { type: "object", properties: { organization_name: nullableString() } },
          ],
        },
        CreateEnterpriseAppRequest: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9._-]+$" },
            label: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: ["string", "null"], maxLength: 1000 },
            origin: { type: "string", minLength: 1, maxLength: 500, format: "uri" },
            subdomain: { type: "string", minLength: 1, maxLength: 63 },
            sso_audience: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", enum: ["available", "disabled"] },
            sort_order: { type: "integer", minimum: 0, maximum: 10_000 },
            organization_id: { type: ["string", "null"], format: "uuid" },
          },
          required: ["id", "label", "origin", "subdomain", "sso_audience"],
        },
        UpdateEnterpriseAppRequest: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: ["string", "null"], maxLength: 1000 },
            origin: { type: "string", minLength: 1, maxLength: 500, format: "uri" },
            subdomain: { type: "string", minLength: 1, maxLength: 63 },
            sso_audience: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", enum: ["available", "disabled"] },
            sort_order: { type: "integer", minimum: 0, maximum: 10_000 },
            organization_id: { type: ["string", "null"], format: "uuid" },
          },
        },
        IdCreated: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, id: { type: "string" } },
          required: ["ok", "id"],
        },

        // ---- API keys (admin governance) --------------------------------
        AdminApiKeyItem: {
          type: "object",
          properties: {
            id: uuid(),
            app_user_id: uuid(),
            owner_email: { type: "string" },
            owner_name: nullableString(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            name: { type: "string" },
            key_prefix: { type: "string" },
            scopes: stringArray(),
            status: { type: "string", enum: CREDENTIAL_STATUS },
            expires_at: dateTime(true),
            last_used_at: dateTime(true),
            last_used_ip: nullableString(),
            created_at: dateTime(),
            revoked_at: dateTime(true),
            revoked_reason: nullableString(),
          },
          required: ["id", "name", "key_prefix", "status"],
        },
        AdminApiKeyList: listOf("AdminApiKeyItem"),
        AdminApiKeyDetail: {
          allOf: [
            ref("AdminApiKeyItem"),
            {
              type: "object",
              properties: {
                created_by_email: nullableString(),
                revoked_by_email: nullableString(),
              },
            },
          ],
        },
        CreateAdminApiKeyRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            ownerAppUserId: uuid(),
            scopes: { type: "array", items: { type: "string" }, maxItems: 64 },
            expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
          },
          required: ["name", "ownerAppUserId"],
        },
        AdminApiKeyCreated: {
          type: "object",
          properties: {
            id: uuid(),
            name: { type: "string" },
            prefix: { type: "string" },
            scopes: stringArray(),
            expiresAt: dateTime(true),
            key: { type: "string", description: "Plaintext secret — shown once." },
          },
          required: ["id", "name", "prefix", "key"],
        },
        AdminApiKeyRotated: {
          allOf: [
            ref("AdminApiKeyCreated"),
            { type: "object", properties: { rotatedFrom: uuid() } },
          ],
        },
        AdminApiKeyRevoked: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, alreadyRevoked: boolean() },
          required: ["ok", "alreadyRevoked"],
        },

        // ---- Email -------------------------------------------------------
        // The list row is METADATA ONLY (review #221); the rendered bodies
        // are served per row by `GET /email/outbox/{id}` (OutboxDetail).
        OutboxItem: {
          type: "object",
          properties: OUTBOX_ITEM_PROPERTIES,
          required: ["id", "to_email", "status"],
        },
        OutboxDetail: {
          type: "object",
          description:
            "One outbox row with its rendered bodies. Bodies are the REDACTED rendering stored at insert time: one-time reset / verification / invitation tokens read `[redacted]`.",
          properties: {
            ...OUTBOX_ITEM_PROPERTIES,
            body_html: { type: "string" },
            body_text: nullableString(),
          },
          required: ["id", "to_email", "status", "body_html"],
        },
        OutboxList: listOf("OutboxItem"),
        EmailTemplate: {
          type: "object",
          properties: {
            id: uuid(),
            key: { type: "string" },
            locale: { type: "string" },
            subject: { type: "string" },
            body_html: { type: "string" },
            body_text: nullableString(),
            description: nullableString(),
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "key", "locale", "subject"],
        },
        EmailTemplateListEnvelope: {
          type: "object",
          properties: { items: { type: "array", items: ref("EmailTemplate") } },
          required: ["items"],
        },
        UpdateEmailTemplateRequest: {
          type: "object",
          properties: {
            subject: { type: "string", minLength: 1, maxLength: 500 },
            body_html: { type: "string", minLength: 1, maxLength: 100_000 },
            body_text: { type: ["string", "null"], maxLength: 100_000 },
            description: { type: ["string", "null"], maxLength: 1000 },
          },
          required: ["subject", "body_html"],
        },
        SendTestEmailRequest: {
          type: "object",
          properties: { to: { type: "string", format: "email" } },
          required: ["to"],
        },
        SendTestEmailResult: {
          type: "object",
          properties: { ok: boolean(), status: { type: "string" }, outboxId: uuid() },
          required: ["ok", "status", "outboxId"],
        },

        // ---- Audit -------------------------------------------------------
        UserRoleAssignmentItem: {
          type: "object",
          properties: {
            id: { type: "string" },
            role_id: uuid(),
            role_key: { type: "string" },
            role_name: { type: "string" },
            role_description: nullableString(),
            organization_id: uuid(),
            organization_slug: { type: "string" },
            organization_name: { type: "string" },
            created_at: dateTime(),
          },
          required: ["id", "role_id", "role_key", "role_name", "organization_id", "created_at"],
        },
        UserRoleAssignmentList: listOf("UserRoleAssignmentItem"),
        AuditEventItem: {
          type: "object",
          properties: {
            id: uuid(),
            event_type: { type: "string" },
            outcome: { type: "string" },
            actor_better_auth_user_id: nullableString(),
            app_user_id: { type: ["string", "null"], format: "uuid" },
            organization_id: { type: ["string", "null"], format: "uuid" },
            target_application_id: nullableString(),
            provider: nullableString(),
            email: nullableString(),
            ip_address: nullableString(),
            user_agent: nullableString(),
            reason: nullableString(),
            metadata: { type: "object", additionalProperties: true },
            created_at: dateTime(),
          },
          required: ["id", "event_type", "outcome", "created_at"],
        },
        AuditEventList: listOf("AuditEventItem"),

        // ---- MCP agents (review #192) --------------------------------------
        // Mirrors `McpAgentSummary` (src/lib/mcp/agents.ts) — camelCase, not a
        // raw row: the list is a join projection the console renders as-is.
        McpAgentItem: {
          type: "object",
          properties: {
            clientRowId: {
              ...uuid(),
              description: "OAuth-client row id — the `{id}` of the agent operations.",
            },
            clientId: { type: "string", description: "Public OAuth `client_id`." },
            name: { type: "string" },
            scopes: {
              ...stringArray(),
              description: "Scope ceiling (effective = scopes ∩ permissions).",
            },
            clientStatus: { type: "string", description: "Raw `app_oauth_clients.status`." },
            appUserId: { ...uuid(), description: "The agent's service account." },
            userStatus: {
              type: "string",
              description: "Raw `app_users.status` of the service account.",
            },
            email: { type: "string" },
            organizationId: { type: ["string", "null"], format: "uuid" },
            createdAt: dateTime(),
            status: {
              type: "string",
              enum: MCP_AGENT_STATUS,
              description:
                "Derived lifecycle status (pending ⇒ awaiting approval; revoked ⇒ client inactive).",
            },
          },
          required: [
            "clientRowId",
            "clientId",
            "name",
            "scopes",
            "clientStatus",
            "appUserId",
            "userStatus",
            "email",
            "organizationId",
            "createdAt",
            "status",
          ],
        },
        McpAgentList: {
          allOf: [
            listOf("McpAgentItem"),
            {
              type: "object",
              properties: {
                pendingCount: {
                  type: "integer",
                  minimum: 0,
                  description:
                    "Agents awaiting approval across the caller's WHOLE scope — independent of the page and filter.",
                },
              },
              required: ["pendingCount"],
            },
          ],
        },
        McpAgentApproved: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            activated: {
              type: "boolean",
              description: "false when the agent was already active (idempotent).",
            },
          },
          required: ["ok", "activated"],
        },
        UpdateMcpAgentScopesRequest: {
          type: "object",
          properties: { scopes: { type: "array", items: { type: "string" }, maxItems: 64 } },
          required: ["scopes"],
          additionalProperties: false,
        },
        McpAgentScopesResult: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, scopes: stringArray() },
          required: ["ok", "scopes"],
        },
        McpAgentRevoked: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            alreadyRevoked: {
              type: "boolean",
              description: "Present (true) when the client was not active any more — a no-op.",
            },
          },
          required: ["ok"],
        },
      },
    },
    paths: {
      // ---- Users ---------------------------------------------------------
      "/users": {
        get: {
          operationId: "listUsers",
          tags: ["Users"],
          summary: "List users",
          parameters: listParams(["filter[status]"]),
          responses: { "200": okResp("UserList"), ...listErrors() },
        },
        post: {
          operationId: "createUser",
          tags: ["Users"],
          summary: "Create a user",
          requestBody: { required: true, ...json(ref("CreateUserRequest")) },
          responses: { "201": createdResp("UserCreated"), ...writeErrors() },
        },
      },
      "/users/{id}": {
        get: {
          operationId: "getUser",
          tags: ["Users"],
          summary: "Read a user",
          parameters: [idParam()],
          responses: { "200": okResp("UserDetailEnvelope"), ...readErrors() },
        },
        patch: {
          operationId: "updateUser",
          tags: ["Users"],
          summary: "Update a user's display name / locale",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateUserRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deleteUser",
          tags: ["Users"],
          summary: "Soft-delete a user",
          parameters: [idParam()],
          requestBody: json(ref("ReasonRequest")),
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/status": {
        post: {
          operationId: "setUserStatus",
          tags: ["Users"],
          summary: "Approve / block / suspend / reactivate a user",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UserStatusRequest")) },
          responses: { "200": okResp("OkStatus"), ...writeErrors() },
        },
      },
      "/users/{id}/password": {
        post: {
          operationId: "setUserPassword",
          tags: ["Users"],
          summary: "Set a password directly or send a reset email",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("SetPasswordRequest")) },
          responses: {
            "200": {
              description: "OK",
              ...json({
                type: "object",
                properties: { ok: { const: true }, mode: { type: "string" } },
              }),
            },
            ...writeErrors(),
          },
        },
      },
      "/users/{id}/role": {
        post: {
          operationId: "setUserPlatformRole",
          tags: ["Users"],
          summary: "Set the Better Auth platform role (superadmin only)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("SetRoleRequest")) },
          responses: {
            "200": {
              description: "OK",
              ...json({
                type: "object",
                properties: { ok: { const: true }, role: { type: "string" } },
              }),
            },
            ...writeErrors(),
          },
        },
      },
      "/users/{id}/ban": {
        post: {
          operationId: "banUser",
          tags: ["Users"],
          summary: "Ban a user (optionally temporary)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("BanRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/unban": {
        post: {
          operationId: "unbanUser",
          tags: ["Users"],
          summary: "Unban a user",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/restore": {
        post: {
          operationId: "restoreUser",
          tags: ["Users"],
          summary: "Restore a soft-deleted user",
          parameters: [idParam()],
          responses: { "200": okResp("OkStatus"), ...writeErrors() },
        },
      },
      "/users/{id}/impersonate": {
        post: {
          operationId: "startImpersonation",
          tags: ["Users"],
          summary: "Start impersonating a user (sets cookies)",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "stopImpersonation",
          tags: ["Users"],
          summary: "Stop impersonating",
          // The ONE admin operation that narrows the document-level
          // `cookie OR bearer` back to cookie-only: it deliberately does not
          // run through `requireAdminPermission`/`resolveCaller` (stopping must
          // work from the impersonated identity, which holds no admin
          // permission), so it applies `checkTrustedOrigin` UNCONDITIONALLY —
          // there is no `hasBearerCredential` bypass — and then demands a live
          // `getCurrentSession()`. A bearer caller can only ever get
          // `403 untrusted_origin` or `401 unauthenticated` here.
          security: [{ cookieSession: [] }],
          description:
            "Cookie session only. Unlike every other administrator operation this one does not go " +
            "through the permission guard — the authority to stop derives from the live session " +
            "BEING an impersonation session — so it always enforces the `Origin`/`Referer` (CSRF) " +
            "check and always requires a session cookie. A bearer credential cannot authenticate " +
            "here: it answers `403 untrusted_origin` (no `Origin`) or `401 unauthenticated`. " +
            "`400 not_impersonating` when the session is real but not an impersonation.",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/sessions": {
        get: {
          operationId: "listUserSessions",
          tags: ["Users"],
          summary: "List a user's active sessions",
          parameters: [idParam()],
          responses: { "200": okResp("SessionList"), ...readErrors() },
        },
        delete: {
          operationId: "revokeAllUserSessions",
          tags: ["Users"],
          summary: "Revoke all of a user's sessions",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/sessions/{sessionId}": {
        delete: {
          operationId: "revokeUserSession",
          tags: ["Users"],
          summary: "Revoke a single session by its id",
          description:
            "`sessionId` is the `id` of a `SessionItem` from the list — never the session token. " +
            "The server resolves the id to the token itself (review #67/#194); an id that is not one " +
            "of the target user's active sessions is `404 session_not_found`.",
          parameters: [
            idParam(),
            {
              ...idParam("sessionId", "string"),
              description: "`SessionItem.id` from `GET /users/{id}/sessions`.",
            },
          ],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/memberships": {
        get: {
          operationId: "listUserMemberships",
          tags: ["Users"],
          summary: "List a user's organization memberships",
          parameters: [
            idParam(),
            ...listParams(["filter[status]", "filter[organization_id]"], false),
          ],
          responses: { "200": okResp("MembershipList"), ...readErrors() },
        },
        post: {
          operationId: "addUserMembership",
          tags: ["Users"],
          summary: "Add the user to an organization",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AddMembershipRequest")) },
          responses: { "201": createdResp("OkId"), ...writeErrors() },
        },
        patch: {
          operationId: "updateUserMemberships",
          tags: ["Users"],
          summary: "Bulk-update membership statuses",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateMembershipsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
        delete: {
          operationId: "removeUserMemberships",
          tags: ["Users"],
          summary: "Bulk-remove memberships",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("DeleteMembershipsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
      },
      "/users/{id}/app-roles": {
        get: {
          operationId: "listUserAppRoles",
          tags: ["Users"],
          summary: "List a user's role assignments",
          parameters: [idParam()],
          responses: { "200": okResp("AppRoleAssignments"), ...readErrors() },
        },
        post: {
          operationId: "assignUserAppRole",
          tags: ["Users"],
          summary: "Assign a role to the user in an org",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AppRoleRef")) },
          responses: { "201": createdResp("Ok"), ...writeErrors() },
        },
        delete: {
          operationId: "revokeUserAppRole",
          tags: ["Users"],
          summary: "Revoke a role assignment",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AppRoleRef")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/{id}/roles": {
        get: {
          operationId: "listUserRoles",
          tags: ["Users"],
          summary: "List a user's application role assignments",
          parameters: [idParam(), ...listParams(["filter[organization_id]"], false)],
          responses: { "200": okResp("UserRoleAssignmentList"), ...readErrors() },
        },
      },
      "/users/{id}/audit": {
        get: {
          operationId: "listUserAuditEvents",
          tags: ["Users"],
          summary: "List a user's audit events",
          parameters: [idParam(), ...listParams(["filter[event_type]", "filter[outcome]"], false)],
          responses: { "200": okResp("AuditEventList"), ...readErrors() },
        },
      },
      "/users/{id}/groups": {
        get: {
          operationId: "listUserGroups",
          tags: ["Users"],
          summary: "List the groups a user belongs to",
          parameters: [idParam()],
          responses: { "200": okResp("UserGroups"), ...readErrors() },
        },
        post: {
          operationId: "addUserToGroup",
          tags: ["Users"],
          summary: "Add the user to a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UserGroupRef")) },
          responses: { "201": createdResp("Ok"), ...writeErrors() },
        },
        delete: {
          operationId: "removeUserFromGroup",
          tags: ["Users"],
          summary: "Remove the user from a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UserGroupRef")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/users/bulk": {
        post: {
          operationId: "bulkUserAction",
          tags: ["Users"],
          summary: "Apply an action to many users",
          requestBody: { required: true, ...json(ref("BulkUserRequest")) },
          responses: {
            "200": okResp("BulkUserResult"),
            ...listErrors(),
            "429": errRef("RateLimited"),
          },
        },
      },

      // ---- Roles ---------------------------------------------------------
      "/roles": {
        get: {
          operationId: "listRoles",
          tags: ["Roles"],
          summary: "List roles",
          parameters: listParams(["filter[organization]", "filter[scope]", "filter[permission]"]),
          responses: { "200": okResp("RoleList"), ...listErrors() },
        },
        post: {
          operationId: "createRole",
          tags: ["Roles"],
          summary: "Create a role",
          requestBody: { required: true, ...json(ref("CreateRoleRequest")) },
          responses: { "201": createdResp("KeyCreated"), ...writeErrors() },
        },
      },
      "/roles/{id}": {
        get: {
          operationId: "getRole",
          tags: ["Roles"],
          summary: "Read a role with its permissions",
          parameters: [idParam()],
          responses: { "200": okResp("RoleDetailEnvelope"), ...readErrors() },
        },
        patch: {
          operationId: "updateRole",
          tags: ["Roles"],
          summary: "Update a role",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateRoleRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deleteRole",
          tags: ["Roles"],
          summary: "Delete a role",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/roles/{id}/duplicate": {
        post: {
          operationId: "duplicateRole",
          tags: ["Roles"],
          summary: "Duplicate a role with its permissions",
          parameters: [idParam()],
          responses: { "201": createdResp("KeyCreated"), ...writeErrors() },
        },
      },
      "/roles/{id}/permissions": {
        get: {
          operationId: "getRolePermissions",
          tags: ["Roles"],
          summary: "List a role's permission keys",
          parameters: [idParam()],
          responses: { "200": okResp("PermissionsList"), ...readErrors() },
        },
        post: {
          operationId: "addRolePermissions",
          tags: ["Roles"],
          summary: "Attach permissions to a role",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("IdsRequest")) },
          responses: { "200": okResp("PermissionsResult"), ...writeErrors() },
        },
        delete: {
          operationId: "removeRolePermissions",
          tags: ["Roles"],
          summary: "Detach permissions from a role",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("IdsRequest")) },
          responses: { "200": okResp("PermissionsResult"), ...writeErrors() },
        },
      },
      "/roles/{id}/members": {
        get: {
          operationId: "listRoleMembers",
          tags: ["Roles"],
          summary: "List users holding a role",
          parameters: [idParam(), ...listParams([])],
          responses: { "200": okResp("RoleMemberList"), ...readErrors() },
        },
      },

      // ---- Permissions ---------------------------------------------------
      "/permissions": {
        get: {
          operationId: "listPermissions",
          tags: ["Permissions"],
          summary: "List the permission catalog",
          parameters: listParams([]),
          responses: { "200": okResp("PermissionList"), ...listErrors() },
        },
        post: {
          operationId: "createPermission",
          tags: ["Permissions"],
          summary: "Add a permission (superadmin only)",
          requestBody: { required: true, ...json(ref("CreatePermissionRequest")) },
          responses: { "201": createdResp("KeyCreated"), ...writeErrors() },
        },
      },
      "/permissions/{id}": {
        patch: {
          operationId: "updatePermission",
          tags: ["Permissions"],
          summary: "Update a permission's description (superadmin only)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdatePermissionRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deletePermission",
          tags: ["Permissions"],
          summary: "Delete a permission (superadmin only)",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },

      // ---- Groups --------------------------------------------------------
      "/groups": {
        get: {
          operationId: "listGroups",
          tags: ["Groups"],
          summary: "List groups",
          parameters: listParams(["filter[organization]"]),
          responses: { "200": okResp("GroupList"), ...listErrors() },
        },
        post: {
          operationId: "createGroup",
          tags: ["Groups"],
          summary: "Create a group",
          requestBody: { required: true, ...json(ref("CreateGroupRequest")) },
          responses: { "201": createdResp("KeyCreated"), ...writeErrors() },
        },
      },
      "/groups/{id}": {
        get: {
          operationId: "getGroup",
          tags: ["Groups"],
          summary: "Read a group",
          parameters: [idParam()],
          responses: { "200": okResp("GroupDetailEnvelope"), ...readErrors() },
        },
        patch: {
          operationId: "updateGroup",
          tags: ["Groups"],
          summary: "Update a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateGroupRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deleteGroup",
          tags: ["Groups"],
          summary: "Delete a group",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/groups/{id}/members": {
        get: {
          operationId: "listGroupMembers",
          tags: ["Groups"],
          summary: "List a group's members",
          parameters: [idParam(), ...listParams([], false)],
          responses: { "200": okResp("GroupMemberList"), ...readErrors() },
        },
        post: {
          operationId: "addGroupMembers",
          tags: ["Groups"],
          summary: "Add users to a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AppUserIdsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
        delete: {
          operationId: "removeGroupMembers",
          tags: ["Groups"],
          summary: "Remove users from a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AppUserIdsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
      },
      "/groups/{id}/roles": {
        get: {
          operationId: "listGroupRoles",
          tags: ["Groups"],
          summary: "List the roles a group confers",
          parameters: [idParam()],
          responses: { "200": okResp("GroupRoles"), ...readErrors() },
        },
        post: {
          operationId: "addGroupRoles",
          tags: ["Groups"],
          summary: "Attach roles to a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("GroupRoleIdsRequest")) },
          responses: { "200": okResp("GroupRolesResult"), ...writeErrors() },
        },
        delete: {
          operationId: "removeGroupRoles",
          tags: ["Groups"],
          summary: "Detach roles from a group",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("GroupRoleIdsRequest")) },
          responses: { "200": okResp("GroupRolesResult"), ...writeErrors() },
        },
      },

      // ---- Organizations -------------------------------------------------
      "/organizations": {
        get: {
          operationId: "listOrganizations",
          tags: ["Organizations"],
          summary: "List organizations",
          parameters: listParams(["filter[status]", "filter[is_default]"]),
          responses: { "200": okResp("OrganizationList"), ...listErrors() },
        },
        post: {
          operationId: "createOrganization",
          tags: ["Organizations"],
          summary: "Create an organization (superadmin only)",
          requestBody: { required: true, ...json(ref("CreateOrganizationRequest")) },
          responses: { "201": createdResp("KeyCreated"), ...writeErrors() },
        },
      },
      "/organizations/{id}": {
        get: {
          operationId: "getOrganization",
          tags: ["Organizations"],
          summary: "Read an organization",
          parameters: [idParam()],
          responses: { "200": okResp("OrganizationDetail"), ...readErrors() },
        },
        patch: {
          operationId: "updateOrganization",
          tags: ["Organizations"],
          summary: "Update an organization (superadmin only)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateOrganizationRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deleteOrganization",
          tags: ["Organizations"],
          summary: "Delete an organization (superadmin only)",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/organizations/{id}/members": {
        get: {
          operationId: "listOrganizationMembers",
          tags: ["Organizations"],
          summary: "List an organization's members",
          parameters: [idParam(), ...listParams(["filter[status]"])],
          responses: { "200": okResp("OrgMemberList"), ...readErrors() },
        },
        post: {
          operationId: "addOrganizationMember",
          tags: ["Organizations"],
          summary: "Add a member to the organization",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AddOrgMemberRequest")) },
          responses: { "201": createdResp("OkId"), ...writeErrors() },
        },
        patch: {
          operationId: "updateOrganizationMembers",
          tags: ["Organizations"],
          summary: "Bulk-update member statuses",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateMembershipsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
        delete: {
          operationId: "removeOrganizationMembers",
          tags: ["Organizations"],
          summary: "Bulk-remove members",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("DeleteMembershipsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
      },
      "/organizations/{id}/provider-bindings": {
        get: {
          operationId: "listProviderBindings",
          tags: ["Organizations"],
          summary: "List an organization's provider bindings",
          parameters: [idParam(), ...listParams(["filter[provider]"], false)],
          responses: { "200": okResp("ProviderBindingList"), ...readErrors() },
        },
        post: {
          operationId: "addProviderBinding",
          tags: ["Organizations"],
          summary: "Add a provider binding",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("AddProviderBindingRequest")) },
          responses: { "201": createdResp("OkId"), ...writeErrors() },
        },
        delete: {
          operationId: "removeProviderBindings",
          tags: ["Organizations"],
          summary: "Remove provider bindings",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("DeleteBindingsRequest")) },
          responses: { "200": okResp("OkCount"), ...writeErrors() },
        },
      },

      "/organizations/{id}/invitations": {
        get: {
          operationId: "listOrganizationInvitations",
          tags: ["Organizations"],
          summary: "List an organization's invitations",
          parameters: [idParam(), ...listParams(["filter[status]"])],
          responses: { "200": okResp("InvitationList"), ...readErrors() },
        },
        post: {
          operationId: "createOrganizationInvitation",
          tags: ["Organizations"],
          summary: "Invite an email address into the organization (sends the accept link)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("CreateInvitationRequest")) },
          responses: { "201": createdResp("InvitationCreated"), ...writeErrors() },
        },
      },
      "/organizations/{id}/invitations/{invitationId}": {
        delete: {
          operationId: "revokeOrganizationInvitation",
          tags: ["Organizations"],
          summary: "Revoke a pending invitation (the accept link dies immediately)",
          parameters: [idParam(), idParam("invitationId")],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },
      "/organizations/{id}/invitations/{invitationId}/resend": {
        post: {
          operationId: "resendOrganizationInvitation",
          tags: ["Organizations"],
          summary: "Rotate a pending invitation's token + expiry and re-send the email",
          parameters: [idParam(), idParam("invitationId")],
          responses: { "200": okResp("InvitationResent"), ...writeErrors() },
        },
      },
      "/organizations/{id}/auth-settings": {
        get: {
          operationId: "getOrganizationAuthSettings",
          tags: ["Organizations"],
          summary: "Read an organization's signup policy (raw override + effective resolution)",
          parameters: [idParam()],
          responses: { "200": okResp("AuthPolicyEnvelope"), ...readErrors() },
        },
        patch: {
          operationId: "updateOrganizationAuthSettings",
          tags: ["Organizations"],
          summary: "Create or replace the organization's signup-policy override",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateAuthPolicyRequest")) },
          responses: { "200": okResp("AuthPolicyEnvelope"), ...writeErrors() },
        },
        delete: {
          operationId: "resetOrganizationAuthSettings",
          tags: ["Organizations"],
          summary: "Remove the signup-policy override (revert to the platform default)",
          parameters: [idParam()],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },

      // ---- Platform signup defaults (0007) --------------------------------
      "/auth-settings/defaults": {
        get: {
          operationId: "getPlatformAuthSettings",
          tags: ["Organizations"],
          summary: "Read the platform-default signup policy (superadmin only)",
          responses: { "200": okResp("AuthPolicyEnvelope"), ...listErrors() },
        },
        patch: {
          operationId: "updatePlatformAuthSettings",
          tags: ["Organizations"],
          summary: "Update the platform-default signup policy (superadmin only)",
          requestBody: { required: true, ...json(ref("UpdateAuthPolicyRequest")) },
          responses: { "200": okResp("AuthPolicyEnvelope"), ...writeErrors() },
        },
      },

      // ---- Memberships ---------------------------------------------------
      "/memberships": {
        get: {
          operationId: "listMemberships",
          tags: ["Memberships"],
          summary: "List all memberships (cross-org)",
          parameters: listParams([
            "filter[status]",
            "filter[organization_id]",
            "filter[source_provider]",
          ]),
          responses: { "200": okResp("GlobalMembershipList"), ...listErrors() },
        },
      },

      // ---- Enterprise apps ----------------------------------------------
      "/enterprise-apps": {
        get: {
          operationId: "listEnterpriseApps",
          tags: ["Enterprise apps"],
          summary: "List enterprise applications",
          parameters: listParams(["filter[status]", "filter[organization_id]"]),
          responses: { "200": okResp("EnterpriseAppList"), ...listErrors() },
        },
        post: {
          operationId: "createEnterpriseApp",
          tags: ["Enterprise apps"],
          summary: "Register an enterprise application",
          requestBody: { required: true, ...json(ref("CreateEnterpriseAppRequest")) },
          responses: { "201": createdResp("IdCreated"), ...writeErrors() },
        },
      },
      "/enterprise-apps/{id}": {
        get: {
          operationId: "getEnterpriseApp",
          tags: ["Enterprise apps"],
          summary: "Read an enterprise application",
          parameters: [idParam("id", "string")],
          responses: { "200": okResp("EnterpriseAppDetail"), ...readErrors() },
        },
        patch: {
          operationId: "updateEnterpriseApp",
          tags: ["Enterprise apps"],
          summary: "Update an enterprise application",
          parameters: [idParam("id", "string")],
          requestBody: { required: true, ...json(ref("UpdateEnterpriseAppRequest")) },
          responses: { "200": okResp(), ...writeErrors() },
        },
        delete: {
          operationId: "deleteEnterpriseApp",
          tags: ["Enterprise apps"],
          summary: "Delete an enterprise application",
          parameters: [idParam("id", "string")],
          responses: { "200": okResp(), ...writeErrors() },
        },
      },

      // ---- API keys ------------------------------------------------------
      "/api-keys": {
        get: {
          operationId: "listAdminApiKeys",
          tags: ["API keys"],
          summary: "List API keys (governance)",
          parameters: listParams([
            "filter[status]",
            "filter[app_user_id]",
            "filter[organization_id]",
          ]),
          responses: { "200": okResp("AdminApiKeyList"), ...listErrors() },
        },
        post: {
          operationId: "createAdminApiKey",
          tags: ["API keys"],
          summary: "Issue an API key on behalf of a user (secret returned once)",
          requestBody: { required: true, ...json(ref("CreateAdminApiKeyRequest")) },
          responses: {
            "201": createdResp("AdminApiKeyCreated"),
            ...writeErrors({ "422": errRef("Unprocessable") }),
          },
        },
      },
      "/api-keys/{id}": {
        get: {
          operationId: "getAdminApiKey",
          tags: ["API keys"],
          summary: "Read an API key's metadata",
          parameters: [idParam()],
          responses: { "200": okResp("AdminApiKeyDetail"), ...readErrors() },
        },
        delete: {
          operationId: "revokeAdminApiKey",
          tags: ["API keys"],
          summary: "Revoke an API key",
          parameters: [idParam()],
          requestBody: json(ref("ReasonRequest")),
          responses: { "200": okResp("AdminApiKeyRevoked"), ...writeErrors() },
        },
      },
      "/api-keys/{id}/rotate": {
        post: {
          operationId: "rotateAdminApiKey",
          tags: ["API keys"],
          summary: "Rotate an API key (new secret returned once)",
          parameters: [idParam()],
          responses: { "201": createdResp("AdminApiKeyRotated"), ...writeErrors() },
        },
      },

      // ---- Email ---------------------------------------------------------
      "/email/outbox": {
        get: {
          operationId: "listOutbox",
          tags: ["Email"],
          summary: "List the email outbox (metadata only)",
          parameters: listParams(["filter[status]", "filter[template_key]"]),
          responses: { "200": okResp("OutboxList"), ...listErrors() },
        },
      },
      "/email/outbox/{id}": {
        get: {
          operationId: "getOutboxItem",
          tags: ["Email"],
          summary: "Read one outbox row with its (redacted) bodies",
          parameters: [idParam()],
          responses: { "200": okResp("OutboxDetail"), ...readErrors() },
        },
      },
      "/email/templates": {
        get: {
          operationId: "listEmailTemplates",
          tags: ["Email"],
          summary: "List email templates",
          responses: { "200": okResp("EmailTemplateListEnvelope"), ...listErrors() },
        },
      },
      "/email/templates/{id}": {
        get: {
          operationId: "getEmailTemplate",
          tags: ["Email"],
          summary: "Read an email template",
          parameters: [idParam()],
          responses: { "200": okResp("EmailTemplate"), ...readErrors() },
        },
        put: {
          operationId: "updateEmailTemplate",
          tags: ["Email"],
          summary: "Update an email template (superadmin only)",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateEmailTemplateRequest")) },
          responses: { "200": okResp("OkId"), ...writeErrors() },
        },
      },
      "/email/test": {
        post: {
          operationId: "sendTestEmail",
          tags: ["Email"],
          summary: "Send a test email",
          requestBody: { required: true, ...json(ref("SendTestEmailRequest")) },
          // Rate-limited like every other mutation (review #195); no 404/409
          // since there is no target resource.
          responses: {
            "200": okResp("SendTestEmailResult"),
            ...listErrors(),
            "429": errRef("RateLimited"),
          },
        },
      },

      // ---- Audit ---------------------------------------------------------
      "/audit": {
        get: {
          operationId: "listAuditEvents",
          tags: ["Audit"],
          summary: "Read the audit log",
          parameters: [
            ...listParams([
              "filter[event_type]",
              "filter[outcome]",
              "filter[actor]",
              "filter[app_user_id]",
              "filter[organization_id]",
              "filter[target_application_id]",
            ]),
            // `filter[created_at][from|to]` — the audit explorer's date range
            // (route `allowedFilters` includes `created_at`; review #195).
            ...rangeFilterParams("created_at"),
          ],
          responses: { "200": okResp("AuditEventList"), ...listErrors() },
        },
      },

      // ---- Export --------------------------------------------------------
      "/export/{resource}": {
        get: {
          operationId: "exportResource",
          tags: ["Export"],
          summary: "Export a resource as CSV",
          description:
            "Streams the resource as CSV (capped at `X-Export-Limit` rows). Filters are the SAME " +
            "`filter[...]` parameters the resource's list endpoint accepts — the route allow-lists " +
            "them per resource (`ALLOWED_FILTERS_BY_RESOURCE`) and silently drops any other: " +
            "`users` → status; `audit` → event_type, outcome, actor, app_user_id, organization_id, " +
            "target_application_id, created_at[from|to]; `organizations` → status, is_default; " +
            "`roles` → organization, scope; `permissions` → none; `memberships` → status, " +
            "organization_id, source_provider; `enterprise-apps` → status, organization_id. " +
            "Rate-limited per actor (3 burst / one per 20 s).",
          parameters: [
            {
              name: "resource",
              in: "path",
              required: true,
              schema: {
                type: "string",
                enum: [
                  "users",
                  "audit",
                  "organizations",
                  "roles",
                  "permissions",
                  "memberships",
                  "enterprise-apps",
                ],
              },
            },
            paramRef("Sort"),
            paramRef("Q"),
            // Union of every per-resource allow-list (review #195); which
            // resource honours which is spelled out in `description`.
            filterParam("filter[status]", "users, organizations, memberships, enterprise-apps."),
            filterParam("filter[is_default]", "organizations."),
            filterParam("filter[event_type]", "audit."),
            filterParam("filter[outcome]", "audit."),
            filterParam("filter[actor]", "audit — Better Auth actor user id."),
            filterParam("filter[app_user_id]", "audit."),
            filterParam(
              "filter[organization_id]",
              "audit, memberships, enterprise-apps (roles use `filter[organization]`).",
            ),
            filterParam("filter[target_application_id]", "audit."),
            filterParam("filter[organization]", "roles — organization id, or `global`."),
            filterParam("filter[scope]", "roles — `global` | `organization`."),
            filterParam("filter[source_provider]", "memberships."),
            ...rangeFilterParams("created_at").map((p) => ({
              ...p,
              description: `audit — ${String(p.description)}`,
            })),
          ],
          responses: {
            "200": {
              description: "CSV stream",
              headers: {
                "Content-Disposition": { schema: { type: "string" } },
                "X-Export-Limit": { schema: { type: "string" } },
              },
              content: { "text/csv": { schema: { type: "string" } } },
            },
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
            "429": errRef("RateLimited"),
          },
        },
      },

      // ---- MCP agents (review #192) --------------------------------------
      // Console counterpart of `/api/v1/admin/oauth-clients`, confined to
      // self-registered agents. `{id}` is the OAuth-client ROW id.
      "/mcp-agents": {
        get: {
          operationId: "listMcpAgents",
          tags: ["MCP agents"],
          summary:
            "List self-registered MCP agents (pending first) with the scope-wide pending count",
          description:
            "Requires `admin.clients.read`. Pending agents always sort first, then `sort` " +
            "(`created_at` | `name`, default `created_at.desc`). `q` is not supported here. " +
            "`pendingCount` counts every pending agent in the caller's scope regardless of " +
            "page/filter, so a badge stays truthful on any view.",
          parameters: [
            paramRef("Page"),
            paramRef("PageSize"),
            paramRef("Sort"),
            {
              name: "filter[status]",
              in: "query",
              required: false,
              schema: { type: "string", enum: MCP_AGENT_STATUS },
              description: "Derived lifecycle status; an unrecognised value applies no filter.",
            },
          ],
          responses: { "200": okResp("McpAgentList"), ...listErrors() },
        },
      },
      "/mcp-agents/{id}": {
        patch: {
          operationId: "updateMcpAgentScopes",
          tags: ["MCP agents"],
          summary: "Set an agent's scope ceiling",
          description:
            "Requires `admin.clients.manage`. Scopes are validated against the caller's own " +
            "authority (permissions, and for a bearer caller its own scopes) — over-granting is " +
            "`422 invalid_scope` listing `ungrantableScopes`. A granted scope only takes effect " +
            "where the service account also holds the matching permission. A revoked or " +
            "reaper-expired agent is terminal: the scopes cannot be changed and the request is " +
            "`409 agent_inactive` (review #56).",
          parameters: [idParam()],
          requestBody: { required: true, ...json(ref("UpdateMcpAgentScopesRequest")) },
          responses: {
            "200": okResp("McpAgentScopesResult"),
            ...writeErrors({ "422": errRef("Unprocessable") }),
          },
        },
        delete: {
          operationId: "revokeMcpAgent",
          tags: ["MCP agents"],
          summary: "Revoke an agent's OAuth client (idempotent)",
          description:
            "Requires `admin.clients.manage`. The service account is left intact for the audit " +
            "trail; an already-revoked client answers `{ ok: true, alreadyRevoked: true }`.",
          parameters: [idParam()],
          responses: { "200": okResp("McpAgentRevoked"), ...writeErrors() },
        },
      },
      "/mcp-agents/{id}/approve": {
        post: {
          operationId: "approveMcpAgent",
          tags: ["MCP agents"],
          summary: "Approve a pending agent (activate its service account)",
          description:
            "Requires `admin.clients.manage`. Idempotent — an already-active agent answers " +
            "`{ ok: true, activated: false }`. A revoked or reaper-expired agent cannot be " +
            "brought back: the request is `409 agent_inactive` (review #56).",
          parameters: [idParam()],
          responses: { "200": okResp("McpAgentApproved"), ...writeErrors() },
        },
      },
    },
  };
}
