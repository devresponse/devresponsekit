"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * One-time secret reveal, shared by the administrator and account API-key
 * surfaces (P2-6 — previously two byte-identical copies). The plaintext is
 * returned by create / rotate exactly once and never recoverable: this
 * modal is the only place it is shown — a read-only field plus copy, with
 * an explicit warning. `secret === null` keeps it closed.
 *
 * The two surfaces differ only by their translation namespace, which the
 * caller passes; both namespaces expose the same `reveal.*` keys.
 */
type RevealNamespace = "administrator.apiKeys.reveal" | "account.apiKeys.reveal";

export function ApiKeyRevealDialog({
  secret,
  onClose,
  namespace,
}: {
  secret: string | null;
  onClose: () => void;
  namespace: RevealNamespace;
}) {
  const t = useTranslations(namespace);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending "copied" reset on unmount so it never fires on an
  // unmounted component (P2-6).
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the value
      // stays selectable in the field for a manual copy.
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
