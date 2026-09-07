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
 *
 * The CURRENT session is identified by fetching `getSession()` alongside
 * `listSessions()` and matching on the session token (review #239). Before
 * that, "Revoke" on the caller's own row destroyed the live session: the
 * follow-up `listSessions()` came back 401 and the panel showed a generic
 * "could not load sessions" error, with the rest of the app silently
 * signed out until the next navigation. That row is now labelled "This
 * device" and renders NO revoke control at all — not a disabled button, a
 * short hint in its place. The deliberate way to end your own session is
 * Sign out in the brand bar, which also clears client state and lands on
 * the logged-out page; a confirm dialog would still leave the user staring
 * at a broken panel afterwards.
 *
 * The marking is BEST-EFFORT and conditional on `getSession()` succeeding.
 * When that lookup fails, `currentToken` stays null: no row is labelled,
 * every row keeps its Revoke button, and the caller can still revoke their
 * own session (pinned by "still lists sessions when the current-session
 * lookup fails" in tests/component/account-sessions-panel.test.tsx). That
 * is the deliberate trade: the fallback is the pre-#239 behaviour, which is
 * recoverable by signing in again, whereas hiding every control on a
 * transient lookup failure would strand a user who came here precisely to
 * revoke a session they do not recognise.
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
  const [currentToken, setCurrentToken] = useState<string | null>(null);
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
    // `getSession()` rides along so the caller's own row can be marked.
    // Its failure is NOT fatal: an unmarked list is still usable, so it is
    // resolved to `null` rather than rejecting the pair (review #239).
    Promise.all([
      authClient.listSessions(),
      authClient
        .getSession()
        .then((res) => (res as { data?: { session?: { token?: string } } }).data?.session?.token)
        .catch(() => undefined),
    ])
      .then(([list, token]) => {
        if (cancelled) return;
        const data = (list as { data?: ClientSession[] }).data ?? [];
        setSessions(data);
        setCurrentToken(token ?? null);
        setBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("errors.sessionsLoadFailed"));
        setSessions([]);
        setCurrentToken(null);
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadToken]);

  const revokeOne = async (token: string | undefined) => {
    // Guard in the handler too, not only by omitting the row's button: a
    // list that changes under a queued click must never revoke the current
    // session from here (review #239). When `currentToken` is null — the
    // `getSession()` lookup failed — there is nothing to compare against
    // and this guard, like the row marking, is inert.
    if (!token || token === currentToken) return;
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
            const isCurrent = token !== undefined && token === currentToken;
            // Every row's Revoke button used to expose the same accessible
            // name, so a screen-reader user heard "Revoke" N times with no
            // way to tell the rows apart (review #107). Name each button by
            // whatever identifies its row: IP first, else the expiry.
            const rowLabel = s.ipAddress ?? formatExpires(s.expiresAt);
            return (
              <li key={token ?? idx} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-muted-foreground">
                    {t("security.expiresAt", { value: formatExpires(s.expiresAt) })}
                    {isCurrent ? (
                      <span className="text-foreground ml-2 rounded-md border px-1.5 py-0.5 text-xs">
                        {t("security.currentSession")}
                      </span>
                    ) : null}
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
                {isCurrent ? (
                  <p className="text-muted-foreground shrink-0 text-xs">
                    {t("security.currentSessionHint")}
                  </p>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    aria-label={t("security.revokeSession", { session: rowLabel })}
                    onClick={() => revokeOne(token)}
                    disabled={busy || !token}
                  >
                    {t("security.revoke")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
