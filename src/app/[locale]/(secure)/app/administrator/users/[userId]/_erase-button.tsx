"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
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
import { useDialogs } from "@/components/ui/dialog-manager";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Erase-personal-data button for the user detail page (F-151,
 * docs/admin-manager.md "Data export and erasure").
 *
 * Rendered only for a SUPERADMIN (cross-org reach) looking at a soft-deleted,
 * not yet erased account; `POST /api/administrator/users/[id]/erase` enforces
 * all of it again. The action cannot be undone, so the dialog asks twice: the
 * acknowledgement box (as impersonation does) AND the account's address typed
 * out, which the route compares too (`confirmEmail`). On success the page is
 * refreshed from the server, which then shows the pseudonym and no button. */
export function EraseUserButton({ userId, email }: { userId: string; email: string }) {
  const t = useTranslations("administrator.users");
  const dialogs = useDialogs();
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const confirmed = acknowledged && typed.trim().toLowerCase() === email.toLowerCase();

  const handleConfirm = async () => {
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/administrator/users/${encodeURIComponent(userId)}/erase`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail: typed.trim() }),
      });
      if (!res.ok) {
        await dialogs.notify({ description: t("erasure.errorToast"), variant: "destructive" });
        return;
      }
      setOpen(false);
      router.refresh();
      await dialogs.notify({ description: t("erasure.successToast") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setAcknowledged(false);
          setTyped("");
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          {t("actions.erase")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("erasure.confirmTitle", { email })}</AlertDialogTitle>
          <AlertDialogDescription>{t("erasure.confirmDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{t("erasure.confirmEmailLabel")}</Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            placeholder={email}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(v) => setAcknowledged(v === true)}
            aria-label={t("erasure.confirmAck")}
          />
          <span>{t("erasure.confirmAck")}</span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!confirmed || busy}
            onClick={(event) => {
              // Keep the dialog open while the request is in flight.
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {t("erasure.eraseButton")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
