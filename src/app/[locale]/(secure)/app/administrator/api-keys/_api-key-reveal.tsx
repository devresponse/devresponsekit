"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * One-time secret reveal (docs/admin-manager.md §8.12).
 *
 * The plaintext API key is returned by the create / rotate endpoints
 * exactly once and is never recoverable afterwards. This modal is the
 * single place it is shown: a read-only field plus a copy affordance,
 * with an explicit warning. Closing it discards the secret from memory.
 *
 * `secret === null` keeps the dialog closed; pass the plaintext to open.
 */
export function ApiKeyRevealDialog({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("administrator.apiKeys.reveal");
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (insecure context / denied) — the
      // value stays selectable in the field for a manual copy.
    }
  }, [secret]);

  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={secret ?? ""}
            aria-label={t("title")}
            onFocus={(e) => e.currentTarget.select()}
            className="border-input bg-muted h-9 w-full rounded-md border px-2 font-mono text-xs"
          />
          <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" size="sm" onClick={onClose}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
