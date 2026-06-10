import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_BULK_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import {
  BULK_USER_ACTION_PERMISSIONS,
  executeBulkUserAction,
  type BulkUserAction,
  type BulkUserOutcome,
  type BulkUserTarget,
} from "@/lib/admin/user-actions.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/administrator/users/bulk
 *
 * Apply a single action to a batch of users (docs/admin-manager.md
 * §19 Phase 7, §8.2 bulk actions, §20.1 #15).
 *
 * Body shape:
 * ```
 * {
 *   action: "approve" | "block" | "suspend" | "reactivate"
 *         | "ban"     | "unban" | "soft_delete" | "restore",
 *   ids: string[] | "*",         // explicit ids (UUIDs) or "select all matching"
 *   reason?: string,             // required for "ban"
 *   expiresInSeconds?: number,   // optional for "ban"
 *   filters?: {                  // required when ids === "*"
 *     status?: string | string[],
 *     q?: string
 *   }
 * }
 * ```
 *
 * Threat / contract:
 *   - Caller MUST hold the action's specific permission
 *     ({@link BULK_USER_ACTION_PERMISSIONS}). 403 + denied audit on
 *     missing permission.
 *   - `ids` is capped at {@link MAX_BULK_IDS} (500). When `ids === "*"`
 *     the server re-applies the SAME allow-listed filter set the GET
 *     /users endpoint uses, so "select all matching" cannot pivot to
 *     unindexed columns or escape the existing visibility model.
 *   - Each row's outcome is captured in the response so the UI can
 *     surface partial failures; one row failing does not abort the
 *     batch.
 *   - The endpoint is rate-limited via the shared in-memory token
 *     bucket per actor (see {@link DEFAULT_ADMIN_BULK_LIMIT}).
 *   - A summary "admin.users.bulk_action" audit row is written in
 *     addition to the per-row events so the audit explorer can show
 *     "X bulk-banned 247 users at Y" without scanning per-row events.
 */
const MAX_BULK_IDS = 500;

const ALLOWED_STATUS = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

const idsSchema = z.union([z.array(z.uuid()).min(1).max(MAX_BULK_IDS), z.literal("*")]);

const filtersSchema = z
  .object({
    status: z.union([z.string(), z.array(z.string())]).optional(),
    q: z.string().min(1).max(200).optional(),
  })
  .strict()
  .optional();

const bulkSchema = z
  .object({
    action: z.enum([
      "approve",
      "block",
      "suspend",
      "reactivate",
      "ban",
      "unban",
      "soft_delete",
      "restore",
    ]),
    ids: idsSchema,
    reason: z.string().min(1).max(500).optional(),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 365)
      .optional(),
    filters: filtersSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = bulkSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const action: BulkUserAction = parsed.data.action;
  const requiredPerm = BULK_USER_ACTION_PERMISSIONS[action];

  const guard = await requireAdminPermission(request, requiredPerm);
  if (isAdminPermissionDenial(guard)) return guard.response;

  // Tighter bulk-specific budget so a single noisy admin can't sweep
  // the entire user base in a tight loop. Per-row mutations also
  // happen inside the helpers but those are separate audit rows,
  // not separate rate-limit consumes.
  const limited = enforceRateLimit(
    "admin.users.bulk",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_BULK_LIMIT,
  );
  if (limited) return limited;

  // Resolve the target id list. Two paths:
  //   1. Explicit ids — trust the parser's UUID format check, then
  //      look them up in one round-trip.
  //   2. "*"  — re-apply the allow-listed filter set against
  //      `app_users` and cap the result at MAX_BULK_IDS to honour the
  //      same per-request budget.
  let targetIds: string[];
  if (parsed.data.ids === "*") {
    if (!parsed.data.filters) {
      return adminErrorResponse("filters_required_for_select_all", 400, request);
    }
    let q = db.selectFrom("app_users").select(["id"]);
    const status = parsed.data.filters.status;
    if (typeof status === "string" && ALLOWED_STATUS.has(status)) {
      q = q.where("status", "=", status);
    } else if (Array.isArray(status)) {
      const cleaned = status.filter((v) => ALLOWED_STATUS.has(v));
      if (cleaned.length > 0) q = q.where("status", "in", cleaned);
    }
    if (parsed.data.filters.q) {
      const like = `%${parsed.data.filters.q}%`;
      q = q.where((eb) =>
        eb.or([eb("primary_email", "ilike", like), eb("display_name", "ilike", like)]),
      );
    }
    const rows = await q.limit(MAX_BULK_IDS).execute();
    targetIds = rows.map((r) => r.id);
  } else {
    // `idsSchema` already validates UUID format and caps at MAX_BULK_IDS,
    // but defend against drift in the parser by re-checking here.
    targetIds = parsed.data.ids.filter(isUuid).slice(0, MAX_BULK_IDS);
  }

  if (targetIds.length === 0) {
    return NextResponse.json({
      ok: true,
      action,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [] as BulkUserOutcome[],
    });
  }

  // Fetch the per-row metadata needed by the per-row helpers
  // (better_auth_user_id, primary_email, status). Doing this in one
  // round-trip keeps the bulk path O(1) DB reads regardless of batch
  // size.
  const targets = (await db
    .selectFrom("app_users")
    .select(["id", "better_auth_user_id", "primary_email", "status"])
    .where("id", "in", targetIds)
    .execute()) satisfies { id: string }[];

  const targetMap = new Map<string, BulkUserTarget>(
    targets.map((row) => [
      row.id,
      {
        appUserId: row.id,
        betterAuthUserId: row.better_auth_user_id,
        primaryEmail: row.primary_email,
        status: row.status,
      },
    ]),
  );

  const results: BulkUserOutcome[] = [];
  // Sequential rather than Promise.all to keep DB / Better Auth load
  // predictable. 500 sequential ops is fine for v1; if this becomes a
  // bottleneck the loop can be parallelised with a small concurrency
  // window.
  for (const id of targetIds) {
    const target = targetMap.get(id);
    if (!target) {
      results.push({ ok: false, appUserId: id, error: "not_found" });
      continue;
    }
    const outcome = await executeBulkUserAction(
      action,
      target,
      { betterAuthUserId: guard.betterAuthUserId, request },
      { reason: parsed.data.reason, expiresInSeconds: parsed.data.expiresInSeconds },
    );
    results.push(outcome);
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  // Single summary audit row in addition to the per-row events written
  // by the helpers — the audit explorer surfaces this for the "what
  // big bulk action ran at 11:42?" lookup.
  await auditUserAction(
    "admin.users.bulk_action",
    succeeded === results.length ? "success" : "failure",
    {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: results[0]?.appUserId ?? "00000000-0000-0000-0000-000000000000",
      reason: parsed.data.reason ?? null,
      metadata: {
        action,
        attempted: results.length,
        succeeded,
        failed,
        ids: parsed.data.ids === "*" ? "*" : `${targetIds.length} ids`,
      },
    },
  );

  // Touch the parsed action once so the audit row records the original
  // batch surface. Per-row events written by the helpers cover detail.
  return NextResponse.json({
    ok: true,
    action,
    attempted: results.length,
    succeeded,
    failed,
    results,
  });
}
