"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Impersonate-user button for the user detail page (docs/admin-manager.md
 * §19 Phase 7, §13 row actions).
 *
 * Threat / contract:
 *   - Renders only when the parent has confirmed the caller holds
 *     `admin.users.impersonate`. The server is the source of truth —
 *     this component is a UX shortcut.
 *   - Requires the admin to tick the audit-acknowledgement checkbox
 *     before the destructive button enables; this is the
 *     "double-confirm" the spec requires for destructive admin
 *     actions. Without the tick the dialog cannot start the action.
 *   - On success we hard-reload to `/` so every cached client-side
 *     auth state (including the menu and any RSC caches) is rebuilt
 *     under the new impersonated identity. Soft routing via
 *     `router.push` would leave stale RSC fragments in place.
 *   - The endpoint is responsible for setting cookies; we never touch
 *     the cookie jar from JS.
 */
export function ImpersonateUserButton({
  userId,
  email,
  isSelf,
}: {
  userId: string;
  email: string;
  isSelf: boolean;
}) {
  const t = useTranslations("administrator.users");
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  if (isSelf) {
    // Render a disabled button with an explanatory tooltip via title.
    return (
      <Button type="button" variant="outline" size="sm" disabled title={t("impersonation.selfError")}>
        {t("actions.impersonate")}
      </Button>
    );
  }

  const handleConfirm = async () => {
    if (!acknowledged) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/administrator/users/${encodeURIComponent(userId)}/impersonate`,
        { method: "POST", credentials: "same-origin" },
      );
      if (!res.ok) {
        alert(t("impersonation.errorToast"));
        return;
      }
      // Force a full reload so every layer (RSC, client auth state,
      // navigation menu) re-renders under the impersonated identity.
      window.location.assign("/");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setAcknowledged(false);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("actions.impersonate")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("impersonation.confirmTitle", { email })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("impersonation.confirmDescription", { email })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(v) => setAcknowledged(v === true)}
            aria-label={t("impersonation.confirmAck")}
          />
          <span>{t("impersonation.confirmAck")}</span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!acknowledged || busy}
            onClick={(event) => {
              // Prevent the dialog's default close-on-click so we can
              // keep it open while the request is in flight (the
              // window reload below replaces the page anyway).
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {t("impersonation.startButton")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
