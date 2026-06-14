"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogs } from "@/components/ui/dialog-manager";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiKeyRevealDialog } from "@/components/api-keys/api-key-reveal";

/**
 * Self-service API-key manager (Account app).
 *
 * Lists the CALLER'S OWN keys via `GET /api/v1/me/api-keys`, and creates
 * / rotates / revokes through the same self-scoped surface. Every call is
 * bound to the session principal server-side — there is no user id and no
 * way to reach another account's keys. Secrets are surfaced exactly once
 * (on create / rotate) through {@link ApiKeyRevealDialog}.
 *
 * Follows the sessions-panel pattern: a `reloadToken` re-fetches after
 * every mutation; a skeleton covers the first load.
 */
interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function AccountApiKeysPanel({ grantableScopes }: { grantableScopes: string[] }) {
  const t = useTranslations("account.apiKeys");
  const locale = useLocale();
  const dialogs = useDialogs();

  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [revealed, setRevealed] = useState<string | null>(null);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const formatDate = useCallback(
    (value: string | null, fallback: string) => {
      if (!value) return fallback;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : dateFormatter.format(d);
    },
    [dateFormatter],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/me/api-keys", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        return (await res.json()) as { items: ApiKey[] };
      })
      .then((body) => {
        if (cancelled) return;
        setError(null);
        setKeys(body.items);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("loadError"));
        setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const onRevoke = useCallback(
    async (key: ApiKey) => {
      const ok = await dialogs.confirm({
        title: t("revokeConfirm.title"),
        description: t("revokeConfirm.description") + "\n\n" + key.name,
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/me/api-keys/${encodeURIComponent(key.id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!res.ok) {
          setError(t("revokeError"));
          return;
        }
        reload();
      } finally {
        setBusy(false);
      }
    },
    [dialogs, t, reload],
  );

  const onRotate = useCallback(
    async (key: ApiKey) => {
      const ok = await dialogs.confirm({
        title: t("rotateConfirm.title"),
        description: t("rotateConfirm.description") + "\n\n" + key.name,
      });
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/me/api-keys/${encodeURIComponent(key.id)}/rotate`, {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          setError(t("rotateError"));
          return;
        }
        const body = (await res.json().catch(() => null)) as { key?: string } | null;
        reload();
        if (body?.key) setRevealed(body.key);
        else setError(t("rotateError"));
      } finally {
        setBusy(false);
      }
    },
    [dialogs, t, reload],
  );

  return (
    <div className="space-y-8">
      <CreateApiKeyForm
        grantableScopes={grantableScopes}
        busy={busy}
        setBusy={setBusy}
        onCreated={(secret) => {
          reload();
          setRevealed(secret);
        }}
      />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{t("listTitle")}</h2>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {keys === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    <code className="text-muted-foreground text-xs">{key.key_prefix}…</code>
                    <StatusBadge
                      status={key.status}
                      label={t(`status.${key.status}` as "status.active")}
                    />
                  </div>
                  {key.scopes.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="font-mono text-[11px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">{t("noScopes")}</p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    {t("created", { value: formatDate(key.created_at, "—") })} ·{" "}
                    {t("lastUsed", { value: formatDate(key.last_used_at, t("never")) })} ·{" "}
                    {t("expires", { value: formatDate(key.expires_at, t("noExpiry")) })}
                  </p>
                </div>
                {key.status === "active" ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRotate(key)}
                    >
                      {t("actions.rotate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRevoke(key)}
                    >
                      {t("actions.revoke")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ApiKeyRevealDialog
        secret={revealed}
        onClose={() => setRevealed(null)}
        namespace="account.apiKeys.reveal"
      />
    </div>
  );
}

/**
 * Inline "create a new key" form. Scopes are limited to what the caller
 * may grant (passed from the server); the create endpoint re-validates.
 */
function CreateApiKeyForm({
  grantableScopes,
  busy,
  setBusy,
  onCreated,
}: {
  grantableScopes: string[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onCreated: (secret: string) => void;
}) {
  const t = useTranslations("account.apiKeys");
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const sortedScopes = useMemo(() => [...grantableScopes].sort(), [grantableScopes]);

  const toggleScope = (scope: string) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length === 0) {
      setError(t("create.nameRequired"));
      return;
    }

    const body: Record<string, unknown> = { name: name.trim(), scopes: [...scopes] };
    const days = Number.parseInt(expiresInDays, 10);
    if (expiresInDays.trim() !== "" && Number.isFinite(days) && days > 0) {
      body.expiresInDays = days;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/v1/me/api-keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const created = (await res.json()) as { key: string };
        setName("");
        setExpiresInDays("");
        setScopes(new Set());
        onCreated(created.key);
        return;
      }
      if (res.status === 403) {
        const data = (await res.json().catch(() => ({}))) as { ungrantableScopes?: string[] };
        setError(
          data.ungrantableScopes && data.ungrantableScopes.length > 0
            ? t("create.invalidScope", { scopes: data.ungrantableScopes.join(", ") })
            : t("create.error"),
        );
        return;
      }
      setError(t("create.error"));
    } catch {
      setError(t("create.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4 rounded-md border p-4" onSubmit={onSubmit} noValidate>
      <h2 className="text-sm font-semibold">{t("create.title")}</h2>

      <div className="space-y-2">
        <Label htmlFor="new-key-name">{t("create.name")}</Label>
        <Input
          id="new-key-name"
          type="text"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={t("create.namePlaceholder")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-key-expires">{t("create.expiresInDays")}</Label>
        <Input
          id="new-key-expires"
          type="number"
          min={1}
          max={3650}
          step={1}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.currentTarget.value)}
          placeholder={t("create.expiresInDaysPlaceholder")}
        />
        <p className="text-muted-foreground text-xs">{t("create.expiresInDaysHelp")}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("create.scopes")}</legend>
        <p className="text-muted-foreground text-xs">{t("create.scopesHelp")}</p>
        {sortedScopes.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("create.noScopesAvailable")}</p>
        ) : (
          <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
            {sortedScopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-xs">
                <Checkbox checked={scopes.has(scope)} onCheckedChange={() => toggleScope(scope)} />
                <code>{scope}</code>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={busy}>
        {t("create.submit")}
      </Button>
    </form>
  );
}
