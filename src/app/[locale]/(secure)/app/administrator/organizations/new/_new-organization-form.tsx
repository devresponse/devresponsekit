"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Client-side new-organization form (docs/admin-manager.md §19).
 *
 * Mirrors the new-role form's controlled-input style so the two forms
 * share a single pattern. Validation echoes the server Zod schema in
 * `/api/administrator/organizations/route.ts` so the user sees the same
 * rules the server enforces; the server is still the source of truth.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function NewOrganizationForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.orgs");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!SLUG_RE.test(slug) || slug.length === 0 || slug.length > 64) {
      setError(tErr("invalidBody"));
      return;
    }
    if (name.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/organizations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          isDefault,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        if (body.id) {
          router.push(`/${locale}/app/administrator/organizations/${body.id}`);
          router.refresh();
          return;
        }
        router.push(`/${locale}/app/administrator/organizations`);
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
        <Label htmlFor="org-slug">{t("fields.slug")}</Label>
        <Input
          id="org-slug"
          type="text"
          required
          minLength={1}
          maxLength={64}
          value={slug}
          onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
          aria-invalid={error !== null && !SLUG_RE.test(slug) ? true : undefined}
        />
        <p className="text-xs text-neutral-500">{t("fields.slugHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="org-name">{t("fields.name")}</Label>
        <Input
          id="org-name"
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="org-is-default"
          checked={isDefault}
          onCheckedChange={(v) => setIsDefault(v === true)}
        />
        <Label htmlFor="org-is-default">{t("fields.isDefault")}</Label>
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
          onClick={() => router.push(`/${locale}/app/administrator/organizations`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
