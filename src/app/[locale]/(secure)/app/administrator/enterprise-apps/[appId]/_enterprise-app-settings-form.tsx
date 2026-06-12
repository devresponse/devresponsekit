"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_STATUS_VALUES, SUBDOMAIN_RE, isHttpsOrigin } from "@/lib/admin/enterprise-apps";

/**
 * Client-side enterprise application settings form (docs/admin-manager.md
 * §8.10, Phase 6).
 *
 * The application id is read-only — it is the stable text PK referenced
 * by `app_sso_handoff_nonces`. Renaming it would break audit history
 * and in-flight handoffs, so the create-form is the only place to set
 * it.
 *
 * When `canManage` is false, the form is rendered in read-only mode for
 * users with `admin.apps.read` only. Validation helpers are imported
 * from the shared `@/lib/admin/enterprise-apps` module so the rules
 * stay in lock-step with the server.
 */

export interface EnterpriseAppSettingsValue {
  id: string;
  label: string;
  description: string | null;
  origin: string;
  subdomain: string;
  ssoAudience: string;
  status: string;
  sortOrder: number;
  organizationSlug: string | null;
}

export function EnterpriseAppSettingsForm({
  app,
  canManage,
}: {
  app: EnterpriseAppSettingsValue;
  canManage: boolean;
}) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [label, setLabel] = useState(app.label);
  const [description, setDescription] = useState(app.description ?? "");
  const [origin, setOrigin] = useState(app.origin);
  const [subdomain, setSubdomain] = useState(app.subdomain);
  const [ssoAudience, setSsoAudience] = useState(app.ssoAudience);
  const [status, setStatus] = useState(app.status);
  const [sortOrder, setSortOrder] = useState(String(app.sortOrder));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSaved(false);

    if (label.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }
    if (!isHttpsOrigin(origin)) {
      setError(tErr("invalidOrigin"));
      return;
    }
    if (!SUBDOMAIN_RE.test(subdomain)) {
      setError(tErr("invalidBody"));
      return;
    }
    if (ssoAudience.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }
    const sortOrderNum = Number.parseInt(sortOrder, 10);
    if (!Number.isFinite(sortOrderNum) || sortOrderNum < 0) {
      setError(tErr("invalidBody"));
      return;
    }
    if (!APP_STATUS_VALUES.includes(status as (typeof APP_STATUS_VALUES)[number])) {
      setError(tErr("invalidBody"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/administrator/enterprise-apps/${encodeURIComponent(app.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          description: description.trim() === "" ? null : description.trim(),
          origin: origin.trim(),
          subdomain: subdomain.trim(),
          sso_audience: ssoAudience.trim(),
          status,
          sort_order: sortOrderNum,
        }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "invalid_origin") {
          setError(tErr("invalidOrigin"));
        } else {
          setError(tErr("invalidBody"));
        }
        return;
      }
      if (res.status === 403) {
        setError(tErr("forbidden"));
        return;
      }
      if (res.status === 404) {
        setError(tErr("notFound"));
        return;
      }
      setError(t("settings.errorToast"));
    } catch {
      setError(t("settings.errorToast"));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = !canManage || submitting;

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="app-label">{t("fields.label")}</Label>
        <Input
          id="app-label"
          type="text"
          required
          maxLength={200}
          value={label}
          disabled={disabled}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-description">{t("fields.description")}</Label>
        <Input
          id="app-description"
          type="text"
          maxLength={1000}
          value={description}
          disabled={disabled}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-origin">{t("fields.origin")}</Label>
        <Input
          id="app-origin"
          type="url"
          required
          maxLength={500}
          value={origin}
          disabled={disabled}
          onChange={(e) => setOrigin(e.currentTarget.value)}
        />
        <p className="text-muted-foreground text-xs">{t("fields.originHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-subdomain">{t("fields.subdomain")}</Label>
        <Input
          id="app-subdomain"
          type="text"
          required
          maxLength={63}
          value={subdomain}
          disabled={disabled}
          onChange={(e) => setSubdomain(e.currentTarget.value.toLowerCase())}
        />
        <p className="text-muted-foreground text-xs">{t("fields.subdomainHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-audience">{t("fields.ssoAudience")}</Label>
        <Input
          id="app-audience"
          type="text"
          required
          maxLength={200}
          value={ssoAudience}
          disabled={disabled}
          onChange={(e) => setSsoAudience(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-status">{t("fields.status")}</Label>
        <select
          id="app-status"
          value={status}
          disabled={disabled}
          onChange={(e) => setStatus(e.currentTarget.value)}
          className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        >
          {APP_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-sort-order">{t("fields.sortOrder")}</Label>
        <Input
          id="app-sort-order"
          type="number"
          min={0}
          max={10000}
          step={1}
          value={sortOrder}
          disabled={disabled}
          onChange={(e) => setSortOrder(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>{t("fields.organization")}</Label>
        <p className="text-foreground text-sm">
          {app.organizationSlug ? (
            <code className="text-xs">{app.organizationSlug}</code>
          ) : (
            <span className="text-muted-foreground">{t("global")}</span>
          )}
        </p>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-success text-sm" role="status">
          {t("settings.saved")}
        </p>
      ) : null}

      {canManage ? (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {t("settings.save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
