"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Settings tab for the role detail (plan §8.6 — Settings).
 *
 * Edits the name and description. The key is shown read-only because
 * roles are referenced by key in audit metadata and code-paths; a
 * rename would silently break log searches and policy lookups.
 */
export function RoleSettingsForm({
  roleId,
  initialKey,
  initialName,
  initialDescription,
  canUpdate,
}: {
  roleId: string;
  initialKey: string;
  initialName: string;
  initialDescription: string | null;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.roles.settings");
  const tFields = useTranslations("administrator.roles.fields");
  const tErr = useTranslations("administrator.errors");

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSaved(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/administrator/roles/${roleId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim().length > 0 ? description.trim() : null,
        }),
      });
      if (res.ok) {
        setSaved(t("saved"));
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
        <Label htmlFor="role-key-readonly">{tFields("key")}</Label>
        <Input id="role-key-readonly" type="text" readOnly value={initialKey} aria-describedby="key-readonly-hint" />
        <p id="key-readonly-hint" className="text-xs text-neutral-500">
          {t("keyReadOnly")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="role-name-edit">{tFields("name")}</Label>
        <Input
          id="role-name-edit"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={!canUpdate}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role-description-edit">{tFields("description")}</Label>
        <Input
          id="role-description-edit"
          type="text"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          disabled={!canUpdate}
        />
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
