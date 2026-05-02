"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_ID_RE, SUBDOMAIN_RE, isHttpsOrigin } from "@/lib/admin/enterprise-apps";

/**
 * Client-side new enterprise application form (docs/admin-manager.md
 * §8.10, Phase 6).
 *
 * Mirrors the new-organization form's controlled-input style. Validation
 * helpers are imported from the shared `@/lib/admin/enterprise-apps`
 * module so the form mirrors the server's Zod schema exactly; the
 * server is still the source of truth.
 *
 * Note: the application `id` is a stable text primary key referenced by
 * SSO handoff nonces — chosen carefully here, not editable from the
 * detail page.
 */

export function NewEnterpriseAppForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [ssoAudience, setSsoAudience] = useState("");
  const [sortOrder, setSortOrder] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!APP_ID_RE.test(id)) {
      setError(tErr("invalidBody"));
      return;
    }
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

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/enterprise-apps", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: id.trim(),
          label: label.trim(),
          description: description.trim() === "" ? null : description.trim(),
          origin: origin.trim(),
          subdomain: subdomain.trim(),
          sso_audience: ssoAudience.trim(),
          sort_order: sortOrderNum,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        if (body.id) {
          router.push(
            `/${locale}/app/administrator/enterprise-apps/${encodeURIComponent(body.id)}`,
          );
          router.refresh();
          return;
        }
        router.push(`/${locale}/app/administrator/enterprise-apps`);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "id_taken") {
          setError(tErr("idTaken"));
        } else {
          setError(t("new.errorToast"));
        }
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
      setError(t("new.errorToast"));
    } catch {
      setError(t("new.errorToast"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="app-id">{t("fields.id")}</Label>
        <Input
          id="app-id"
          type="text"
          required
          minLength={1}
          maxLength={128}
          value={id}
          onChange={(e) => setId(e.currentTarget.value.toLowerCase())}
        />
        <p className="text-xs text-neutral-500">{t("fields.idHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-label">{t("fields.label")}</Label>
        <Input
          id="app-label"
          type="text"
          required
          maxLength={200}
          value={label}
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
          onChange={(e) => setOrigin(e.currentTarget.value)}
          placeholder="https://example.com"
        />
        <p className="text-xs text-neutral-500">{t("fields.originHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-subdomain">{t("fields.subdomain")}</Label>
        <Input
          id="app-subdomain"
          type="text"
          required
          maxLength={63}
          value={subdomain}
          onChange={(e) => setSubdomain(e.currentTarget.value.toLowerCase())}
        />
        <p className="text-xs text-neutral-500">{t("fields.subdomainHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-audience">{t("fields.ssoAudience")}</Label>
        <Input
          id="app-audience"
          type="text"
          required
          maxLength={200}
          value={ssoAudience}
          onChange={(e) => setSsoAudience(e.currentTarget.value)}
        />
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
          onChange={(e) => setSortOrder(e.currentTarget.value)}
        />
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {t("new.submit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.push(`/${locale}/app/administrator/enterprise-apps`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
