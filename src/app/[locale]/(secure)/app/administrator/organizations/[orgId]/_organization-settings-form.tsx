"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Settings tab for the organization detail (docs/admin-manager.md §19).
 *
 * Edits the name, slug, status and is_default flag.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function OrganizationSettingsForm({
  orgId,
  initialSlug,
  initialName,
  initialStatus,
  initialIsDefault,
  canUpdate,
}: {
  orgId: string;
  initialSlug: string;
  initialName: string;
  initialStatus: string;
  initialIsDefault: boolean;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.settings");
  const tFields = useTranslations("administrator.orgs.fields");
  const tErr = useTranslations("administrator.errors");

  const [slug, setSlug] = useState(initialSlug);
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState(initialStatus);
  const [isDefault, setIsDefault] = useState(initialIsDefault);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSaved(null);
    if (!SLUG_RE.test(slug)) {
      setError(tErr("invalidBody"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/administrator/organizations/${orgId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          status,
          isDefault,
        }),
      });
      if (res.ok) {
        setSaved(t("saved"));
        return;
      }
      if (res.status === 409) {
        setError(tErr("slugTaken"));
        return;
      }
      if (res.status === 400) {
        setError(tErr("invalidBody"));
        return;
      }
      if (res.status === 403) {
        setError(tErr("forbidden"));
        return;
      }
      setError(t("errorToast"));
    } catch {
      setError(t("errorToast"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="org-slug-edit">{tFields("slug")}</Label>
        <Input
          id="org-slug-edit"
          type="text"
          required
          minLength={1}
          maxLength={64}
          value={slug}
          onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
          disabled={!canUpdate}
          aria-invalid={error !== null && !SLUG_RE.test(slug) ? true : undefined}
        />
        <p className="text-xs text-neutral-500">{tFields("slugHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="org-name-edit">{tFields("name")}</Label>
        <Input
          id="org-name-edit"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={!canUpdate}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="org-status-edit">{tFields("status")}</Label>
        <Select value={status} onValueChange={(v) => setStatus(v)} disabled={!canUpdate}>
          <SelectTrigger id="org-status-edit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t("statusActive")}</SelectItem>
            <SelectItem value="pending">{t("statusPending")}</SelectItem>
            <SelectItem value="suspended">{t("statusSuspended")}</SelectItem>
            <SelectItem value="archived">{t("statusArchived")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="org-is-default-edit"
          checked={isDefault}
          onCheckedChange={(v) => setIsDefault(v === true)}
          disabled={!canUpdate}
        />
        <Label htmlFor="org-is-default-edit">{tFields("isDefault")}</Label>
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-green-700" role="status">
          {saved}
        </p>
      ) : null}

      <Button type="submit" disabled={!canUpdate || saving}>
        {t("save")}
      </Button>
    </form>
  );
}
