"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * InviteAcceptForm
 *
 * The signed-in acceptance action on the invite page (0008): posts the
 * plaintext token to `POST /api/invitations/accept` and hard-navigates to
 * the app on success (the membership/status just changed, so a full load
 * re-evaluates the secure gates). A 403 mismatch is mapped to the
 * different-account message; everything else shows a generic retryable
 * error — the server never distinguishes invalid/expired/consumed tokens.
 */
export function InviteAcceptForm({ token, appHref }: { token: string; appHref: string }) {
  const t = useTranslations("auth");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        window.location.assign(appHref);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        body?.error === "invitation_email_mismatch"
          ? t("inviteMismatchDescription")
          : t("inviteError"),
      );
      setSubmitting(false);
    } catch {
      setError(t("inviteError"));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="button" className="w-full" onClick={onAccept} disabled={submitting}>
        {t("inviteAcceptButton")}
      </Button>
    </div>
  );
}
