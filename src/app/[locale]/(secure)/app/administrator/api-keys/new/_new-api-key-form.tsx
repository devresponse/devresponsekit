"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiKeyRevealDialog } from "../_api-key-reveal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Issue-an-API-key-on-behalf-of-a-user form (docs/admin-manager.md
 * §8.12).
 *
 * The owner is identified by their application user id (copyable from
 * the Users console). Scopes are picked from the catalog the server
 * passed down; the server independently rejects any scope the OWNER
 * does not hold, surfaced here as `invalid_scope` with the offending
 * keys. On success the plaintext is revealed exactly once before we
 * return to the list.
 */
export function NewApiKeyForm({
  locale,
  scopeCatalog,
}: {
  locale: string;
  scopeCatalog: string[];
}) {
  const t = useTranslations("administrator.apiKeys");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [name, setName] = useState("");
  const [ownerAppUserId, setOwnerAppUserId] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const sortedScopes = useMemo(() => [...scopeCatalog].sort(), [scopeCatalog]);

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
      setError(tErr("invalidBody"));
      return;
    }
    if (!UUID_RE.test(ownerAppUserId.trim())) {
      setError(t("new.invalidOwnerId"));
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      ownerAppUserId: ownerAppUserId.trim(),
      scopes: [...scopes],
    };
    const days = Number.parseInt(expiresInDays, 10);
    if (expiresInDays.trim() !== "" && Number.isFinite(days) && days > 0) {
      body.expiresInDays = days;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/api-keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const created = (await res.json()) as { key: string };
        setRevealed(created.key);
        return;
      }
      if (res.status === 404) {
        setError(t("new.ownerNotFound"));
        return;
      }
      if (res.status === 409) {
        setError(t("new.ownerInactive"));
        return;
      }
      if (res.status === 422) {
        const data = (await res.json().catch(() => ({}))) as { ungrantableScopes?: string[] };
        setError(
          data.ungrantableScopes && data.ungrantableScopes.length > 0
            ? t("new.invalidScope", { scopes: data.ungrantableScopes.join(", ") })
            : t("new.errorToast"),
        );
        return;
      }
      if (res.status === 403) {
        setError(tErr("forbidden"));
        return;
      }
      setError(t("new.errorToast"));
    } catch {
      setError(t("new.errorToast"));
    } finally {
      setSubmitting(false);
    }
  };

  const backToList = () => {
    router.push(`/${locale}/app/administrator/api-keys`);
    router.refresh();
  };

  return (
    <>
      <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-2">
          <Label htmlFor="apikey-name">{t("fields.name")}</Label>
          <Input
            id="apikey-name"
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder={t("fields.namePlaceholder")}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="apikey-owner">{t("fields.owner")}</Label>
          <Input
            id="apikey-owner"
            type="text"
            required
            value={ownerAppUserId}
            onChange={(e) => setOwnerAppUserId(e.currentTarget.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
          <p className="text-muted-foreground text-xs">{t("fields.ownerHelp")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="apikey-expires">{t("fields.expiresInDays")}</Label>
          <Input
            id="apikey-expires"
            type="number"
            min={1}
            max={3650}
            step={1}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.currentTarget.value)}
            placeholder={t("fields.expiresInDaysPlaceholder")}
          />
          <p className="text-muted-foreground text-xs">{t("fields.expiresInDaysHelp")}</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("fields.scopes")}</legend>
          <p className="text-muted-foreground text-xs">{t("fields.scopesHelp")}</p>
          <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
            {sortedScopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-xs">
                <Checkbox checked={scopes.has(scope)} onCheckedChange={() => toggleScope(scope)} />
                <code>{scope}</code>
              </label>
            ))}
          </div>
        </fieldset>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {t("new.submit")}
          </Button>
          <Button type="button" variant="outline" disabled={submitting} onClick={backToList}>
            {t("new.cancel")}
          </Button>
        </div>
      </form>
      <ApiKeyRevealDialog
        secret={revealed}
        onClose={() => {
          setRevealed(null);
          backToList();
        }}
      />
    </>
  );
}
