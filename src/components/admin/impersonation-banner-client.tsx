"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Client half of {@link ImpersonationBanner} — the "Stop impersonating"
 * button. Calls `DELETE /api/administrator/users/[id]/impersonate` and
 * hard-reloads on success so every cached layer rebuilds under the original
 * actor.
 *
 * The DELETE handler IGNORES the `[id]` segment: it resolves the impersonated
 * user from the session itself and never validates or 404s on the id
 * (review #109). `targetAppUserId` is `null` when the banner failed to
 * resolve the target's `app_users` row (e.g. the impersonated identity has no
 * application record yet); the fallback id below only satisfies the URL
 * shape. Only a 2xx counts as success (P2-1) — see the handler comment.
 *
 * In practice the null case only happens during dev fixtures; production
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
        // Reload into the secure app (not the public landing) so the restored
        // admin lands back inside the shell. Locale = first path segment.
        const seg = window.location.pathname.split("/")[1] ?? "";
        const locale = isSupportedLocale(seg) ? seg : "en";
        window.location.assign(`/${locale}/app/dashboard`);
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
