"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrganizationPicker } from "../../_components/organization-picker";

/**
 * Client-side new-role form (plan §8.5 + §8.6 — Settings analogue).
 *
 * Mirrors the new-user form's controlled-input style so the two forms
 * share a single pattern. Validation echoes the server Zod schema in
 * `/api/administrator/roles/route.ts` so the user sees the same rules
 * the server enforces; the server is still the source of truth.
 *
 * Scope (ADR-0001):
 *   - a SUPERADMIN may create a Global role or scope it to any org, so the
 *     {@link OrganizationPicker} is shown with the Global option;
 *   - an ORG ADMIN may only create a role in their own org, so no picker is
 *     shown and `defaultOrganizationId` (their org) is sent — a global role
 *     would be rejected with 403.
 */
const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

export function NewRoleForm({
  locale,
  showOrgPicker,
  defaultOrganizationId,
}: {
  locale: string;
  showOrgPicker: boolean;
  defaultOrganizationId: string | null;
}) {
  const t = useTranslations("administrator.roles");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [organizationId, setOrganizationId] = useState<string | null>(defaultOrganizationId);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!KEY_RE.test(key) || key.length === 0 || key.length > 120) {
      setError(tErr("invalidBody"));
      return;
    }
    if (name.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/roles", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: key.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          organizationId,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        if (body.id) {
          router.push(`/${locale}/app/administrator/roles/${body.id}`);
          router.refresh();
          return;
        }
        router.push(`/${locale}/app/administrator/roles`);
        return;
      }
      if (res.status === 409) {
        setError(tErr("keyTaken"));
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
          id="role-organization"
          includeGlobal
          value={organizationId}
          onChange={setOrganizationId}
        />
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="role-key">{t("fields.key")}</Label>
        <Input
          id="role-key"
          type="text"
          required
          minLength={1}
          maxLength={120}
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          aria-invalid={error !== null && !KEY_RE.test(key) ? true : undefined}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role-name">{t("fields.name")}</Label>
        <Input
          id="role-name"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role-description">{t("fields.description")}</Label>
        <Input
          id="role-description"
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
          onClick={() => router.push(`/${locale}/app/administrator/roles`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
