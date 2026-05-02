"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Sessions tab for the user detail page (plan §8.4 — Sessions).
 *
 * Owns its own fetch against `GET /api/administrator/users/[id]/sessions`
 * so the heavier auth-side query only runs when the user opens the tab.
 *
 * Per-row "Revoke" calls `DELETE .../sessions/[sessionId]`; the
 * "Revoke all" button calls `DELETE .../sessions`. Both refresh the
 * list on success and surface API errors inline (no toast dependency
 * is added here — the existing UI surface intentionally keeps the
 * dependency footprint of this slice small).
 */
interface RawSession {
  id?: string;
  token?: string;
  expiresAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function UserSessionsPanel({ userId }: { userId: string }) {
  const t = useTranslations("administrator.users");
  const tGrid = useTranslations("administrator.grid");
  const locale = useLocale();

  const [sessions, setSessions] = useState<RawSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const formatExpires = useCallback(
    (iso: string | null | undefined): string => {
      if (!iso) return "—";
      const d = new Date(iso);
      return Number.isNaN(d.getTime())
        ? iso
        : new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(d);
    },
    [locale],
  );

  const reload = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/sessions`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError(tGrid("error"));
        setSessions([]);
        return;
      }
      const body = (await res.json()) as { sessions?: RawSession[] };
      setSessions(body.sessions ?? []);
    } catch {
      setError(tGrid("error"));
      setSessions([]);
    } finally {
      setBusy(false);
    }
  }, [userId, tGrid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revokeOne = async (token: string | undefined) => {
    if (!token) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/administrator/users/${userId}/sessions/${encodeURIComponent(token)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!res.ok) setError(tGrid("error"));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/sessions`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) setError(tGrid("error"));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("sessions.title")}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={revokeAll}
          disabled={busy || (sessions?.length ?? 0) === 0}
        >
          {t("sessions.revokeAll")}
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {sessions === null ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-neutral-500">{t("sessions.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {sessions.map((s, idx) => {
            const token = s.token ?? s.id;
            return (
              <li key={token ?? idx} className="flex items-start justify-between gap-3 p-3">
                <div className="space-y-1">
                  <p>
                    <span className="text-neutral-500">{t("sessions.expiresAt", { value: formatExpires(s.expiresAt) })}</span>
                  </p>
                  {s.ipAddress ? (
                    <p className="text-xs text-neutral-500">
                      {t("sessions.ipAddress")}: <code>{s.ipAddress}</code>
                    </p>
                  ) : null}
                  {s.userAgent ? (
                    <p className="truncate text-xs text-neutral-500" title={s.userAgent}>
                      {t("sessions.userAgent")}: {s.userAgent}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revokeOne(token)}
                  disabled={busy || !token}
                >
                  {t("sessions.revokeOne")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
