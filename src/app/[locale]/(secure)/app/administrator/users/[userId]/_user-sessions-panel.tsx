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
  // Starts true: the mount effect fetches immediately, and deriving the
  // initial busy state avoids a synchronous setState inside the effect.
  const [busy, setBusy] = useState(true);

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

  // Refetch trigger: handlers bump the token (after their own sync
  // busy/error resets — events may set state synchronously, effects
  // must not), and the effect performs the fetch with all state
  // commits inside async continuations. `busy` clears when the fetch
  // settles, so it stays true across a revoke + refetch sequence.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/administrator/users/${userId}/sessions`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        return (await res.json()) as { sessions?: RawSession[] };
      })
      .then((body) => {
        if (cancelled) return;
        setSessions(body.sessions ?? []);
        setBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(tGrid("error"));
        setSessions([]);
        setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, tGrid, reloadToken]);

  const revokeOne = async (token: string | undefined) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/administrator/users/${userId}/sessions/${encodeURIComponent(token)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!res.ok) setError(tGrid("error"));
    } catch {
      setError(tGrid("error"));
    }
    // The refetch clears `busy` when it settles.
    setReloadToken((t) => t + 1);
  };

  const revokeAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/sessions`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) setError(tGrid("error"));
    } catch {
      setError(tGrid("error"));
    }
    setReloadToken((t) => t + 1);
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
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {sessions === null ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("sessions.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {sessions.map((s, idx) => {
            const token = s.token ?? s.id;
            return (
              <li key={token ?? idx} className="flex items-start justify-between gap-3 p-3">
                <div className="space-y-1">
                  <p>
                    <span className="text-muted-foreground">
                      {t("sessions.expiresAt", { value: formatExpires(s.expiresAt) })}
                    </span>
                  </p>
                  {s.ipAddress ? (
                    <p className="text-muted-foreground text-xs">
                      {t("sessions.ipAddress")}: <code>{s.ipAddress}</code>
                    </p>
                  ) : null}
                  {s.userAgent ? (
                    <p className="text-muted-foreground truncate text-xs" title={s.userAgent}>
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
