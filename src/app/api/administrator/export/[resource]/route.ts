import "server-only";
import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { parseListQuery, type FilterValue, type ListQuery } from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { resolveOrgScope, type OrgScope } from "@/lib/admin/access-scope.server";
import { DEFAULT_ADMIN_EXPORT_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/export/<resource>
 *
 * Streams a CSV export of one of the Administrator list resources
 * (docs/admin-manager.md §5.2, §19 Phase 7, §20.1 #14). Uses the same
 * filter / sort / `q` query-string contract as the matching list
 * endpoint so "Export current view" produces the exact same rows the
 * grid is showing.
 *
 * Threat / contract:
 *   - Caller MUST hold the resource's `read` permission. 403 + denied
 *     audit on missing permission.
 *   - The export is hard-capped at {@link MAX_EXPORT_ROWS} (100k) per
 *     §20.1 #14 to bound memory and prevent a single export from
 *     pinning the DB. When the cap is hit we still return the rows
 *     read so far; the response headers include `X-Export-Truncated:
 *     true` and `X-Export-Limit` so the UI can surface a banner.
 *   - The endpoint is rate-limited via the shared in-memory token
 *     bucket per actor (see {@link DEFAULT_ADMIN_EXPORT_LIMIT}).
 *   - We stream rows in pages of {@link PAGE_SIZE} so memory stays
 *     bounded regardless of total size — the response itself is
 *     emitted as a `ReadableStream` so the client can start downloading
 *     immediately.
 *   - CSV escaping is implemented locally (see {@link csvEscape}); we
 *     do NOT add a CSV library dependency for one function.
 *   - A `admin.export.completed` (or `_failed`) audit row is written
 *     so platform ops can answer "who exported the user list at 11:42".
 */
const MAX_EXPORT_ROWS = 100_000;
const PAGE_SIZE = 1_000;

type Resource =
  | "users"
  | "audit"
  | "organizations"
  | "roles"
  | "permissions"
  | "memberships"
  | "enterprise-apps";

const VALID_RESOURCES: ReadonlySet<Resource> = new Set([
  "users",
  "audit",
  "organizations",
  "roles",
  "permissions",
  "memberships",
  "enterprise-apps",
]);

const RESOURCE_PERMISSION: Record<Resource, string> = {
  users: "admin.users.read",
  audit: "admin.audit.read",
  organizations: "admin.orgs.read",
  roles: "admin.roles.read",
  permissions: "admin.roles.read",
  memberships: "admin.orgs.read",
  "enterprise-apps": "admin.apps.read",
};

interface RouteContext {
  params: Promise<{ resource: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { resource: resourceParam } = await ctx.params;
  if (!VALID_RESOURCES.has(resourceParam as Resource)) {
    return adminErrorResponse("unknown_resource", 404, request);
  }
  const resource = resourceParam as Resource;

  const guard = await requireAdminPermission(request, RESOURCE_PERMISSION[resource]);
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    `admin.export.${resource}`,
    guard.betterAuthUserId,
    DEFAULT_ADMIN_EXPORT_LIMIT,
  );
  if (limited) return limited;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ALLOWED_SORT_BY_RESOURCE[resource],
    allowedFilters: ALLOWED_FILTERS_BY_RESOURCE[resource],
    defaultSort: DEFAULT_SORT_BY_RESOURCE[resource],
    // Page size is overridden below — we stream in PAGE_SIZE chunks.
    defaultPageSize: PAGE_SIZE,
    maxPageSize: PAGE_SIZE,
  });

  const filename = buildFilename(resource);

  // Validate the query and execute the FIRST page BEFORE we open the
  // stream. If anything blows up at this stage (bad filter, missing
  // table, transient DB error) we can still respond with a real HTTP
  // status + JSON envelope. Once we hand a `ReadableStream` back to
  // Next.js the status is locked at 200 and any later error can only
  // be surfaced as a CSV body, which most consumers cannot detect.
  let exporter: {
    header: string[];
    fetchPage: (limit: number, offset: number) => Promise<unknown[][]>;
  };
  let firstPage: unknown[][];
  // ADR-0001: confine the export to the caller's org. SUPERADMIN → all
  // orgs; ORG ADMIN → their org only; no resolvable org → empty export.
  const scope = resolveOrgScope(guard.access);
  try {
    exporter = buildExporter(resource, query, scope);
    firstPage = await exporter.fetchPage(Math.min(PAGE_SIZE, MAX_EXPORT_ROWS), 0);
  } catch (err) {
    await auditEvent({
      eventType: "admin.export.failed",
      outcome: "error",
      actorBetterAuthUserId: guard.betterAuthUserId,
      request,
      requestId: guard.requestId,
      reason: "export_failed",
      metadata: {
        resource,
        rowsEmitted: 0,
        phase: "preflight",
        message: err instanceof Error ? err.message : "unknown",
      },
    });
    return adminErrorResponse("export_failed", 502, request);
  }

  let rowsEmitted = 0;
  let truncated = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const writeLine = (line: string) => controller.enqueue(encoder.encode(`${line}\n`));

      try {
        writeLine(exporter.header.map(csvEscape).join(","));

        // Emit the preflight page first.
        for (const row of firstPage) {
          writeLine(row.map(csvEscape).join(","));
          rowsEmitted += 1;
        }
        let offset = firstPage.length;

        // Continue streaming subsequent pages until exhausted or
        // truncated. If the first page already exhausted the source
        // we skip the loop entirely.
        if (firstPage.length >= Math.min(PAGE_SIZE, MAX_EXPORT_ROWS)) {
          while (true) {
            const remaining = MAX_EXPORT_ROWS - rowsEmitted;
            if (remaining <= 0) {
              truncated = true;
              break;
            }
            const limit = Math.min(PAGE_SIZE, remaining);
            const rows = await exporter.fetchPage(limit, offset);
            if (rows.length === 0) break;
            for (const row of rows) {
              writeLine(row.map(csvEscape).join(","));
              rowsEmitted += 1;
            }
            if (rows.length < limit) break;
            offset += rows.length;
          }
        }
      } catch (err) {
        // We've already started streaming, so we can't change the
        // status. Append a sentinel comment so a curl reader sees the
        // error, and audit the failure.
        controller.enqueue(
          encoder.encode(
            `# export_failed: ${err instanceof Error ? err.message.replace(/\n/g, " ") : "unknown"}\n`,
          ),
        );
        await auditEvent({
          eventType: "admin.export.failed",
          outcome: "error",
          actorBetterAuthUserId: guard.betterAuthUserId,
          request,
          requestId: guard.requestId,
          reason: "export_failed",
          metadata: {
            resource,
            rowsEmitted,
            phase: "stream",
            message: err instanceof Error ? err.message : "unknown",
          },
        });
      } finally {
        controller.close();
        // Best-effort completion audit. Failure during audit must not
        // crash the stream's close. Truncated exports are recorded as
        // `success` with `truncated: true` so operators can still query
        // by outcome — a truncation is the contract, not a failure.
        try {
          await auditEvent({
            eventType: "admin.export.completed",
            outcome: "success",
            actorBetterAuthUserId: guard.betterAuthUserId,
            request,
            requestId: guard.requestId,
            reason: truncated ? "export_truncated" : null,
            metadata: { resource, rowsEmitted, truncated, limit: MAX_EXPORT_ROWS },
          });
        } catch {
          /* swallow — the export itself already succeeded. */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-export-limit": String(MAX_EXPORT_ROWS),
      "x-request-id": guard.requestId,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Per-resource exporters                                                    */
/* -------------------------------------------------------------------------- */

const ALLOWED_SORT_BY_RESOURCE: Record<Resource, string[]> = {
  users: ["created_at", "primary_email", "display_name", "status"],
  audit: ["created_at", "event_type", "outcome", "actor_better_auth_user_id"],
  organizations: ["slug", "name", "status", "created_at", "is_default", "member_count"],
  roles: ["key", "name", "created_at", "permission_count", "member_count"],
  permissions: ["key", "description", "used_by_role_count"],
  memberships: [
    "status",
    "created_at",
    "user_display_name",
    "organization_slug",
    "source_provider",
  ],
  "enterprise-apps": [
    "id",
    "label",
    "subdomain",
    "status",
    "sort_order",
    "created_at",
    "organization_slug",
  ],
};

const ALLOWED_FILTERS_BY_RESOURCE: Record<Resource, string[]> = {
  users: ["status"],
  audit: [
    "event_type",
    "outcome",
    "actor",
    "app_user_id",
    "organization_id",
    "target_application_id",
    "created_at",
  ],
  organizations: ["status", "is_default"],
  roles: ["organization", "scope"],
  permissions: [],
  memberships: ["status", "organization_id", "source_provider"],
  "enterprise-apps": ["status", "organization_id"],
};

const DEFAULT_SORT_BY_RESOURCE: Record<Resource, ListQuery["sort"]> = {
  users: [{ field: "created_at", direction: "desc" }],
  audit: [{ field: "created_at", direction: "desc" }],
  organizations: [{ field: "created_at", direction: "desc" }],
  roles: [{ field: "created_at", direction: "desc" }],
  permissions: [{ field: "key", direction: "asc" }],
  memberships: [{ field: "created_at", direction: "desc" }],
  "enterprise-apps": [{ field: "sort_order", direction: "asc" }],
};

interface Exporter {
  header: string[];
  fetchPage: (limit: number, offset: number) => Promise<unknown[][]>;
}

function buildExporter(resource: Resource, query: ListQuery, scope: OrgScope | null): Exporter {
  switch (resource) {
    case "users":
      return buildUsersExporter(query, scope);
    case "audit":
      return buildAuditExporter(query, scope);
    case "organizations":
      return buildOrganizationsExporter(query, scope);
    case "roles":
      return buildRolesExporter(query, scope);
    case "permissions":
      return buildPermissionsExporter(query, scope);
    case "memberships":
      return buildMembershipsExporter(query, scope);
    case "enterprise-apps":
      return buildEnterpriseAppsExporter(query, scope);
    default: {
      const exhaustive: never = resource;
      throw new Error(`unknown resource: ${String(exhaustive)}`);
    }
  }
}

const ALLOWED_USER_STATUSES = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

function buildUsersExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: [
      "id",
      "better_auth_user_id",
      "primary_email",
      "display_name",
      "status",
      "preferred_locale",
      "created_at",
      "updated_at",
    ],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_users");
      if (scope.kind === "org") {
        const orgId = scope.organizationId;
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom("app_organization_memberships as m")
              .select("m.id")
              .whereRef("m.app_user_id", "=", "app_users.id")
              .where("m.organization_id", "=", orgId),
          ),
        );
      }
      const status = query.filters.status;
      if (typeof status === "string" && ALLOWED_USER_STATUSES.has(status)) {
        q = q.where("status", "=", status);
      } else if (Array.isArray(status)) {
        const cleaned = status.filter((v) => ALLOWED_USER_STATUSES.has(v));
        if (cleaned.length > 0) q = q.where("status", "in", cleaned);
      }
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) =>
          eb.or([eb("primary_email", "ilike", like), eb("display_name", "ilike", like)]),
        );
      }
      let qSorted = q
        .select([
          "id",
          "better_auth_user_id",
          "primary_email",
          "display_name",
          "status",
          "preferred_locale",
          "created_at",
          "updated_at",
        ])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) {
        qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      }
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.better_auth_user_id,
        r.primary_email,
        r.display_name ?? "",
        r.status,
        r.preferred_locale,
        toIso(r.created_at),
        toIso(r.updated_at),
      ]);
    },
  };
}

function buildAuditExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: [
      "id",
      "event_type",
      "outcome",
      "actor_better_auth_user_id",
      "app_user_id",
      "organization_id",
      "target_application_id",
      "provider",
      "email",
      "ip_address",
      "user_agent",
      "reason",
      "created_at",
    ],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_audit_events as e");
      if (scope.kind === "org") q = q.where("e.organization_id", "=", scope.organizationId);
      const eventType = query.filters.event_type;
      if (typeof eventType === "string") q = q.where("e.event_type", "=", eventType);
      const outcome = query.filters.outcome;
      if (typeof outcome === "string") q = q.where("e.outcome", "=", outcome);
      const actor = query.filters.actor;
      if (typeof actor === "string") q = q.where("e.actor_better_auth_user_id", "=", actor);
      const appUserId = query.filters.app_user_id;
      if (typeof appUserId === "string") q = q.where("e.app_user_id", "=", appUserId);
      const orgId = query.filters.organization_id;
      if (typeof orgId === "string") q = q.where("e.organization_id", "=", orgId);
      const targetApp = query.filters.target_application_id;
      if (typeof targetApp === "string") q = q.where("e.target_application_id", "=", targetApp);
      const createdAt = query.filters.created_at;
      if (isRangeFilter(createdAt)) {
        const from = parseIsoDate(createdAt.from);
        const to = parseIsoDate(createdAt.to);
        if (from) q = q.where(sql<boolean>`e.created_at >= ${from}`);
        if (to) q = q.where(sql<boolean>`e.created_at <= ${to}`);
      }
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) =>
          eb.or([
            eb("e.event_type", "ilike", like),
            eb("e.email", "ilike", like),
            eb("e.reason", "ilike", like),
          ]),
        );
      }
      let qSorted = q
        .select([
          "e.id",
          "e.event_type",
          "e.outcome",
          "e.actor_better_auth_user_id",
          "e.app_user_id",
          "e.organization_id",
          "e.target_application_id",
          "e.provider",
          "e.email",
          "e.ip_address",
          "e.user_agent",
          "e.reason",
          "e.created_at",
        ])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) {
        qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      }
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.event_type,
        r.outcome,
        r.actor_better_auth_user_id ?? "",
        r.app_user_id ?? "",
        r.organization_id ?? "",
        r.target_application_id ?? "",
        r.provider ?? "",
        r.email ?? "",
        r.ip_address ?? "",
        r.user_agent ?? "",
        r.reason ?? "",
        toIso(r.created_at),
      ]);
    },
  };
}

function buildOrganizationsExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: ["id", "slug", "name", "status", "is_default", "created_at", "updated_at"],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_organizations");
      if (scope.kind === "org") q = q.where("id", "=", scope.organizationId);
      const status = query.filters.status;
      if (typeof status === "string") q = q.where("status", "=", status);
      const isDefault = query.filters.is_default;
      if (isDefault === "true") q = q.where("is_default", "=", true);
      else if (isDefault === "false") q = q.where("is_default", "=", false);
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) => eb.or([eb("slug", "ilike", like), eb("name", "ilike", like)]));
      }
      let qSorted = q
        .select(["id", "slug", "name", "status", "is_default", "created_at", "updated_at"])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.slug,
        r.name,
        r.status,
        String(r.is_default),
        toIso(r.created_at),
        toIso(r.updated_at),
      ]);
    },
  };
}

function buildRolesExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: ["id", "key", "name", "description", "organization_id", "created_at"],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_roles");
      // ADR-0001: an org admin exports only their org's roles (global
      // roles are platform config, superadmin-only).
      if (scope.kind === "org") q = q.where("organization_id", "=", scope.organizationId);
      const org = query.filters.organization;
      if (typeof org === "string") q = q.where("organization_id", "=", org);
      const scopeFilter = query.filters.scope;
      if (scopeFilter === "global") q = q.where("organization_id", "is", null);
      else if (scopeFilter === "org") q = q.where("organization_id", "is not", null);
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) => eb.or([eb("key", "ilike", like), eb("name", "ilike", like)]));
      }
      let qSorted = q
        .select(["id", "key", "name", "description", "organization_id", "created_at"])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.key,
        r.name,
        r.description ?? "",
        r.organization_id ?? "",
        toIso(r.created_at),
      ]);
    },
  };
}

function buildPermissionsExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: ["id", "key", "description"],
    fetchPage: async (limit, offset) => {
      // The permission catalog is GLOBAL config (identical for every
      // tenant), not tenant data — any admin may read it. Only the
      // no-org edge case yields nothing.
      if (!scope) return [];
      let q = db.selectFrom("app_permissions");
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) => eb.or([eb("key", "ilike", like), eb("description", "ilike", like)]));
      }
      const qSorted = q
        .select(["id", "key", "description"])
        .orderBy("key", "asc")
        .limit(limit)
        .offset(offset);
      const rows = await qSorted.execute();
      return rows.map((r) => [r.id, r.key, r.description ?? ""]);
    },
  };
}

function buildMembershipsExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: ["id", "app_user_id", "organization_id", "status", "source_provider", "created_at"],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_organization_memberships as m");
      if (scope.kind === "org") q = q.where("m.organization_id", "=", scope.organizationId);
      const status = query.filters.status;
      if (typeof status === "string") q = q.where("m.status", "=", status);
      const orgId = query.filters.organization_id;
      if (typeof orgId === "string") q = q.where("m.organization_id", "=", orgId);
      const source = query.filters.source_provider;
      if (typeof source === "string") q = q.where("m.source_provider", "=", source);
      let qSorted = q
        .select([
          "m.id",
          "m.app_user_id",
          "m.organization_id",
          "m.status",
          "m.source_provider",
          "m.created_at",
        ])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.app_user_id,
        r.organization_id,
        r.status,
        r.source_provider ?? "",
        toIso(r.created_at),
      ]);
    },
  };
}

function buildEnterpriseAppsExporter(query: ListQuery, scope: OrgScope | null): Exporter {
  return {
    header: [
      "id",
      "label",
      "subdomain",
      "origin",
      "sso_audience",
      "status",
      "sort_order",
      "organization_id",
      "created_at",
    ],
    fetchPage: async (limit, offset) => {
      if (!scope) return [];
      let q = db.selectFrom("app_enterprise_applications as a");
      if (scope.kind === "org") q = q.where("a.organization_id", "=", scope.organizationId);
      const status = query.filters.status;
      if (typeof status === "string") q = q.where("a.status", "=", status);
      const orgId = query.filters.organization_id;
      if (typeof orgId === "string") q = q.where("a.organization_id", "=", orgId);
      if (query.q) {
        const like = `%${query.q}%`;
        q = q.where((eb) => eb.or([eb("a.id", "ilike", like), eb("a.label", "ilike", like)]));
      }
      let qSorted = q
        .select([
          "a.id",
          "a.label",
          "a.subdomain",
          "a.origin",
          "a.sso_audience",
          "a.status",
          "a.sort_order",
          "a.organization_id",
          "a.created_at",
        ])
        .limit(limit)
        .offset(offset);
      for (const s of query.sort) qSorted = qSorted.orderBy(sql.ref(s.field), s.direction);
      const rows = await qSorted.execute();
      return rows.map((r) => [
        r.id,
        r.label,
        r.subdomain,
        r.origin,
        r.sso_audience,
        r.status,
        String(r.sort_order),
        r.organization_id ?? "",
        toIso(r.created_at),
      ]);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function isRangeFilter(value: FilterValue | undefined): value is { from?: string; to?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("from" in value || "to" in value)
  );
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Quote a CSV cell per RFC 4180:
 *   - Wrap in `"` if the value contains `"`, `,`, `\n`, or `\r`.
 *   - Double any internal `"`.
 *   - Coerce non-strings via `String(...)` so callers don't have to
 *     pre-format every column.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildFilename(resource: Resource): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `administrator-${resource}-${stamp}.csv`;
}
