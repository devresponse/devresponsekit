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
  errorLabel,
}: {
  targetAppUserId: string | null;
  label: string;
  errorLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const id = targetAppUserId ?? FALLBACK_ID;
      const res = await fetch(`/api/administrator/users/${encodeURIComponent(id)}/impersonate`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      // P2-1: only treat a 2xx as success. The route returns its error
      // status BEFORE clearing the impersonation cookie, so on failure the
      // session is STILL impersonated — navigating home would silently
      // strand the admin in the impersonated view. Surface the error and
      // let them retry instead.
      if (res.ok) {
        window.location.assign("/");
        return;
      }
      setFailed(true);
      setBusy(false);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      {failed ? (
        <span className="text-destructive text-xs" role="alert">
          {errorLabel}
        </span>
      ) : null}
      <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={busy}>
        {label}
      </Button>
    </span>
  );
}
