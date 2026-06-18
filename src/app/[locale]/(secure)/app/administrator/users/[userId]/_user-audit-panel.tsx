"use client";

import { AdministratorAuditGrid } from "../../audit/_audit-grid";

/**
 * Audit tab for the user detail (docs/admin-manager.md §8.4).
 *
 * Reuses the shared audit grid pointed at the per-user audit endpoint, which
 * scopes rows to this user's `app_user_id` (and to the caller's org per
 * ADR-0001). The global filter toolbar is hidden — the view is already scoped.
 */
export function UserAuditPanel({ userId }: { userId: string }) {
  return (
    <AdministratorAuditGrid
      endpoint={`/api/administrator/users/${userId}/audit`}
      name={`administrator.user-audit.${userId}`}
      showToolbar={false}
    />
  );
}
