"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Settings tab for the group detail (ADR-0002). Edits name + description;
 * the `key` is read-only (referenced by audit metadata).
 */
export function GroupSettingsForm({
  groupId,
  initialKey,
  initialName,
  initialDescription,
  canUpdate,
}: {
  groupId: string;
  initialKey: string;
  initialName: string;
  initialDescription: string | null;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.groups.settings");
  const tFields = useTranslations("administrator.groups.fields");
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
      const res = await fetch(`/api/administrator/groups/${groupId}`, {
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
        <Label htmlFor="group-key-readonly">{tFields("key")}</Label>
        <Input id="group-key-readonly" type="text" readOnly value={initialKey} />
        <p className="text-muted-foreground text-xs">{t("keyReadOnly")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="group-name-edit">{tFields("name")}</Label>
        <Input
          id="group-name-edit"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={!canUpdate}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="group-description-edit">{tFields("description")}</Label>
        <Input
          id="group-description-edit"
          type="text"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          disabled={!canUpdate}
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-success text-sm" role="status">
          {saved}
        </p>
      ) : null}

      <Button type="submit" disabled={!canUpdate || saving}>
        {t("save")}
      </Button>
    </form>
  );
}
