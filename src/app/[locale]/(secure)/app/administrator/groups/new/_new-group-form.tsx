"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrganizationPicker } from "../../_components/organization-picker";

/**
 * Client-side new-group form (ADR-0002). Groups are ALWAYS org-scoped:
 *   - an ORG ADMIN's group is created in their own org server-side, so no
 *     picker is shown (`showOrgPicker={false}`);
 *   - a SUPERADMIN must choose the target org via {@link OrganizationPicker}
 *     and that `organizationId` is sent to the server.
 */
const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

export function NewGroupForm({
  locale,
  showOrgPicker,
}: {
  locale: string;
  showOrgPicker: boolean;
}) {
  const t = useTranslations("administrator.groups");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!KEY_RE.test(key) || key.length === 0 || key.length > 120 || name.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }
    // A SUPERADMIN must pick a target org (groups are never global).
    if (showOrgPicker && !organizationId) {
      setError(t("new.organizationRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/groups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: key.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          // Org admins omit this — the server forces their own org.
          ...(showOrgPicker ? { organizationId } : {}),
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/groups/${body.id}`
            : `/${locale}/app/administrator/groups`,
        );
        router.refresh();
        return;
      }
      if (res.status === 409) {
        setError(tErr("keyTaken"));
        return;
      }
      if (res.status === 400) {
        setError(t("new.organizationRequired"));
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
      {showOrgPicker ? (
        <OrganizationPicker
          id="group-organization"
          value={organizationId}
          onChange={setOrganizationId}
        />
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="group-key">{t("fields.key")}</Label>
        <Input
          id="group-key"
          type="text"
          required
          minLength={1}
          maxLength={120}
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="group-name">{t("fields.name")}</Label>
        <Input
          id="group-name"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="group-description">{t("fields.description")}</Label>
        <Input
          id="group-description"
          type="text"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
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
          onClick={() => router.push(`/${locale}/app/administrator/groups`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
