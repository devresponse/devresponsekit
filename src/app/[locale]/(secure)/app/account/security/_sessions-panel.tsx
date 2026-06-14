"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";

/**
 * Active-sessions manager (self-service). Lists the CALLER'S OWN sessions
 * through Better Auth's client (`authClient.listSessions`) and revokes
 * them individually or all-but-current. The client is bound to the
 * current session, so every call is inherently self-scoped — there is no
 * user id and no way to reach another account's sessions.
 */
interface ClientSession {
  id?: string;
  token?: string;
  expiresAt?: string | Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function AccountSessionsPanel() {
  const t = useTranslations("account");
  const locale = useLocale();

  const [sessions, setSessions] = useState<ClientSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const formatExpires = useCallback(
    (value: string | Date | null | undefined): string => {
      if (!value) return "—";
      const d = new Date(value);
      return Number.isNaN(d.getTime())
        ? String(value)
        : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    },
    [locale],
  );

  useEffect(() => {
    let cancelled = false;
    authClient
      .listSessions()
      .then((res) => {
        if (cancelled) return;
        const data = (res as { data?: ClientSession[] }).data ?? [];
        setSessions(data);
        setBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("errors.sessionsLoadFailed"));
        setSessions([]);
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadToken]);

  const revokeOne = async (token: string | undefined) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      // Better Auth's client resolves with `{ data, error }` rather than
      // throwing on an API error, so a rejected revoke must be read off
      // `result.error` — not assumed successful (P2-1).
      const result = await authClient.revokeSession({ token });
      if (result?.error) setError(t("errors.sessionsRevokeFailed"));
    } catch {
      setError(t("errors.sessionsRevokeFailed"));
    }
    setReloadToken((n) => n + 1);
  };

  const revokeOthers = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.revokeOtherSessions();
      if (result?.error) setError(t("errors.sessionsRevokeFailed"));
    } catch {
      setError(t("errors.sessionsRevokeFailed"));
    }
    setReloadToken((n) => n + 1);
  };

  return (
    <div className="w-full space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t("security.sessionsDescription")}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={revokeOthers}
          disabled={busy || (sessions?.length ?? 0) <= 1}
        >
          {t("security.revokeOthers")}
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
        <p className="text-muted-foreground text-sm">{t("security.noSessions")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {sessions.map((s, idx) => {
            const token = s.token ?? s.id;
            return (
              <li key={token ?? idx} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-muted-foreground">
                    {t("security.expiresAt", { value: formatExpires(s.expiresAt) })}
                  </p>
                  {s.ipAddress ? (
                    <p className="text-muted-foreground text-xs break-all">
                      {t("security.ipAddress")}: <code>{s.ipAddress}</code>
                    </p>
                  ) : null}
                  {s.userAgent ? (
                    <p className="text-muted-foreground text-xs break-words" title={s.userAgent}>
                      {t("security.userAgent")}: {s.userAgent}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => revokeOne(token)}
                  disabled={busy || !token}
                >
                  {t("security.revoke")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
