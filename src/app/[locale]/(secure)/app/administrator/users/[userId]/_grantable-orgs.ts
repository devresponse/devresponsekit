import { useEffect, useState } from "react";
import { fetchAllPages } from "@/lib/admin/admin-list.client";
import { GRANT_ELIGIBLE_MEMBERSHIP_STATUS } from "@/lib/validation/organizations";

/**
 * The organizations a user may be granted a role or a group in, for the
 * user-detail role and group pickers (F-154).
 *
 * The server grants only to an ACTIVE member of the role's or group's org
 * (`grantEligibleUserIds`), so the pickers list only those orgs' roles and
 * groups. They read the user's memberships of that status
 * (`GET …/users/[id]/memberships`, confined to the caller's scope, so an org
 * admin sees their own org at most), and send each org to the list endpoint as
 * a repeated `filter[organization]`. The role picker used to search every role
 * in the caller's scope, so a superadmin was offered, and could assign, a role
 * in an org the user had never joined.
 */

interface MembershipRow {
  id: string;
  organization_id: string;
  organization_name: string | null;
}

/**
 * The most orgs sent as repeated `filter[organization]` values (about 6 KB of
 * query string). A user in more orgs is searched across the caller's whole
 * scope instead, where typing an org's name still narrows the list, and the
 * server still refuses an org the user is not an active member of.
 */
const MAX_FILTERED_ORGS = 100;

/**
 * `endpoint` confined to `orgIds`; `null` when there are none (nothing to
 * ask). `endpoint` may carry fixed filters already (`?filter[scope]=org`).
 */
export function scopedToOrgs(endpoint: string, orgIds: readonly string[]): string | null {
  if (orgIds.length === 0) return null;
  if (orgIds.length > MAX_FILTERED_ORGS) return endpoint;
  const qs = new URLSearchParams(orgIds.map((orgId) => ["filter[organization]", orgId]));
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${qs.toString()}`;
}

/**
 * The user's grant-eligible orgs (id → name), `null` while loading, and
 * whether they failed to load.
 */
export function useGrantableOrgs(userId: string): {
  orgs: ReadonlyMap<string, string> | null;
  error: boolean;
} {
  const [orgs, setOrgs] = useState<ReadonlyMap<string, string> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ "filter[status]": GRANT_ELIGIBLE_MEMBERSHIP_STATUS });
    fetchAllPages<MembershipRow>(
      `/api/administrator/users/${encodeURIComponent(userId)}/memberships?${qs.toString()}`,
    )
      .then(({ items }) => {
        if (cancelled) return;
        setOrgs(new Map(items.map((m) => [m.organization_id, m.organization_name ?? ""])));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { orgs, error };
}
