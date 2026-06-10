"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Client half of {@link ImpersonationBanner} — the "Stop impersonating"
 * button. Calls `DELETE /api/administrator/users/[id]/impersonate`
 * (which requires the [id] for symmetry / audit) and hard-reloads on
 * success so every cached layer rebuilds under the original actor.
 *
 * `targetAppUserId` is `null` when the banner failed to resolve the
 * target's `app_users` row (e.g. the impersonated identity has no
 * application record yet) — in that case we fall back to a known-bad
 * sentinel UUID so the endpoint's UUID validator still passes; the
 * server then returns 404 and the cookie clear still fires from the
 * server-side stop call we route through `auth.api.stopImpersonating`.
 *
 * In practice this only happens during dev fixtures; production
 * always has the matching app row.
 */
const FALLBACK_ID = "00000000-0000-0000-0000-000000000000";

export function StopImpersonationButton({
  targetAppUserId,
  label,
}: {
  targetAppUserId: string | null;
  label: string;
}) {
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = targetAppUserId ?? FALLBACK_ID;
      await fetch(`/api/administrator/users/${encodeURIComponent(id)}/impersonate`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    } finally {
      // Reload regardless of the response — even on a partial failure
      // the safer UX is to drop back to the original session view and
      // surface any error there.
      window.location.assign("/");
    }
  };

  return (
    <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={busy}>
      {label}
    </Button>
  );
}
