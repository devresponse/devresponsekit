/**
 * OpenAPI 3.1 document for the cookie-session `/api/administrator/*` console
 * API — the basis for the committed internal admin SDK
 * (`pnpm openapi:export` → `docs/openapi-admin.json`, then `pnpm sdk:admin:generate`).
 *
 * This surface is NOT the public machine API (`/api/v1`, see `openapi.ts`):
 * it authenticates with the Better Auth **session cookie**, and every
 * mutation additionally requires an `Origin`/`Referer` header matching a
 * trusted origin (CSRF guard). Errors use the admin envelope
 * `{ error, message, requestId }`. List endpoints share the
 * `{ items, page, pageSize, total, sort }` envelope; mutations mostly return
 * `{ ok: true, … }`. Responses are raw snake_case rows.
 */
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
const AUTH_POLICY_METHODS = ["email", "google", "microsoft", "github"];
const AUTH_POLICY_MODES = ["admin_approval", "auto_active"];

/** A path id parameter. */
const idParam = (name = "id", format: "uuid" | "string" = "uuid"): Obj => ({
  name,
  in: "path",
  required: true,
  schema: format === "uuid" ? uuid() : { type: "string" },
});

/** Shared list-query params for an endpoint. */
const listParams = (filters: string[] = [], q = true): Obj[] => {
  const out: Obj[] = [paramRef("Page"), paramRef("PageSize"), paramRef("Sort")];
  if (q) out.push(paramRef("Q"));
  for (const f of filters) {
    out.push({
      name: f,
      in: "query",
      required: false,
      explode: true,
      style: "form",
      schema: { type: "array", items: { type: "string" } },
      description: "Exact-match filter; repeat for multiple values.",
    });
  }
  return out;
};

const okResp = (schemaName = "Ok"): Obj => ({ description: "OK", ...json(ref(schemaName)) });
const createdResp = (schemaName: string): Obj => ({
  description: "Created",
  ...json(ref(schemaName)),
});

/** Standard error responses for a read endpoint. */
const readErrors = (): Obj => ({
  "400": errRef("BadRequest"),
  "403": errRef("Forbidden"),
  "404": errRef("NotFound"),
});
/** Standard error responses for a mutating endpoint. */
const writeErrors = (extra: Record<string, Obj> = {}): Obj => ({
  "400": errRef("BadRequest"),
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
        "Cookie-session Administrator console API (`/api/administrator`). Authenticate with the " +
        "Better Auth **session cookie** (send credentials with the request). Every **mutation** also " +
        "requires an `Origin` (or `Referer`) header matching a trusted origin — the CSRF guard — so a " +
        "non-browser client must set it explicitly. Org admins are scoped to their own organization " +
        "(out-of-scope resources return 404, not 403). Errors use `{ error, message, requestId }`; " +
        "every response carries an `x-request-id` header.",
    },
    servers: [{ url: `${baseUrl}/api/administrator` }],
    security: [{ cookieSession: [] }],
    tags: [
      { name: "Users", description: "User administration." },
      { name: "Roles", description: "Roles and their permissions." },
      { name: "Permissions", description: "The permission catalog." },
      { name: "Groups", description: "Organization groups (ADR-0002)." },
      { name: "Organizations", description: "Tenants and their members / provider bindings." },
      { name: "Memberships", description: "User↔organization memberships." },
      { name: "Enterprise apps", description: "SSO application registry." },
      { name: "API keys", description: "API-key governance." },
      { name: "Email", description: "Outbox and templates." },
      { name: "Audit", description: "The audit log." },
      { name: "Export", description: "CSV exports." },
    ],
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description:
            "Better Auth session cookie. Browser clients send it automatically; server clients must " +
            "forward it (and an `Origin` header on mutations).",
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
        Unauthorized: { description: "Not signed in", ...json(ref("AdminError")) },
        Forbidden: {
          description: "Insufficient permission (or out of org scope)",
          ...json(ref("AdminError")),
        },
        NotFound: { description: "Not found (or out of org scope)", ...json(ref("AdminError")) },
        Conflict: { description: "Conflict", ...json(ref("AdminError")) },
        Unprocessable: {
          description: "Unprocessable (e.g. ungrantable scopes)",
          ...json(ref("AdminError")),
        },
        RateLimited: {
          description: "Too many requests",
          headers: { "Retry-After": { schema: { type: "string" } } },
          ...json(ref("AdminError")),
        },
      },
      schemas: {
        AdminError: {
          type: "object",
          description: "Administrator error envelope.",
          properties: {
            error: { type: "string", description: "Machine-readable code." },
            message: { type: "string", description: "i18n message key." },
            requestId: { type: "string" },
          },
          required: ["error", "message", "requestId"],
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
        SessionList: {
          type: "object",
          properties: {
            sessions: { type: "array", items: { type: "object", additionalProperties: true } },
          },
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
            ids: { oneOf: [{ type: "array", items: uuid(), maxItems: 500 }, { const: "*" }] },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            expiresInSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
            filters: {
              type: "object",
              properties: {
                status: { type: "array", items: { type: "string" } },
                q: { type: "string", minLength: 1, maxLength: 200 },
              },
            },
          },
          required: ["action", "ids"],
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
        OutboxItem: {
          type: "object",
          properties: {
            id: uuid(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            organization_slug: nullableString(),
            organization_name: nullableString(),
            template_key: nullableString(),
            to_email: { type: "string" },
            from_email: { type: "string" },
            subject: { type: "string" },
            body_html: { type: "string" },
            body_text: nullableString(),
            status: { type: "string", enum: ["pending", "sent", "failed", "logged"] },
            provider: nullableString(),
            provider_message_id: nullableString(),
            error: nullableString(),
            related_better_auth_user_id: nullableString(),
            created_at: dateTime(),
            sent_at: dateTime(true),
          },
          required: ["id", "to_email", "status"],
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
          responses: {
            "200": okResp("UserList"),
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
          },
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
          summary: "Revoke a single session",
          parameters: [idParam(), idParam("sessionId", "string")],
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
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
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
          responses: {
            "200": okResp("RoleList"),
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
          },
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
          responses: {
            "200": okResp("PermissionList"),
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
          },
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
          responses: {
            "200": okResp("GroupList"),
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
          },
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
          responses: { "200": okResp("OrganizationList"), "403": errRef("Forbidden") },
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
          responses: { "200": okResp("AuthPolicyEnvelope"), "403": errRef("Forbidden") },
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
          responses: { "200": okResp("GlobalMembershipList"), "403": errRef("Forbidden") },
        },
      },

      // ---- Enterprise apps ----------------------------------------------
      "/enterprise-apps": {
        get: {
          operationId: "listEnterpriseApps",
          tags: ["Enterprise apps"],
          summary: "List enterprise applications",
          parameters: listParams(["filter[status]", "filter[organization_id]"]),
          responses: { "200": okResp("EnterpriseAppList"), "403": errRef("Forbidden") },
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
          responses: { "200": okResp("AdminApiKeyList"), "403": errRef("Forbidden") },
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
          summary: "List the email outbox",
          parameters: listParams(["filter[status]", "filter[template_key]"]),
          responses: { "200": okResp("OutboxList"), "403": errRef("Forbidden") },
        },
      },
      "/email/templates": {
        get: {
          operationId: "listEmailTemplates",
          tags: ["Email"],
          summary: "List email templates",
          responses: { "200": okResp("EmailTemplateListEnvelope"), "403": errRef("Forbidden") },
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
          responses: {
            "200": okResp("SendTestEmailResult"),
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
          },
        },
      },

      // ---- Audit ---------------------------------------------------------
      "/audit": {
        get: {
          operationId: "listAuditEvents",
          tags: ["Audit"],
          summary: "Read the audit log",
          parameters: listParams([
            "filter[event_type]",
            "filter[outcome]",
            "filter[actor]",
            "filter[app_user_id]",
            "filter[organization_id]",
            "filter[target_application_id]",
          ]),
          responses: { "200": okResp("AuditEventList"), "403": errRef("Forbidden") },
        },
      },

      // ---- Export --------------------------------------------------------
      "/export/{resource}": {
        get: {
          operationId: "exportResource",
          tags: ["Export"],
          summary: "Export a resource as CSV",
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
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
          },
        },
      },
    },
  };
}
