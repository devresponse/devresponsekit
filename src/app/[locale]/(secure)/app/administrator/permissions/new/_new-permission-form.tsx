"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Client-side new-permission form (plan §8.7), following the same
 * new-record pattern as `users/new/_new-user-form.tsx`: plain
 * controlled inputs, client validation mirroring the server Zod
 * schema (the server stays the source of truth), submit + Cancel at
 * the bottom — no back link, no slide-over panel.
 */
const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

export function NewPermissionForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.permissions");
  const tFields = useTranslations("administrator.permissions.fields");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const trimmed = key.trim();
    if (trimmed.length === 0 || !KEY_RE.test(trimmed)) {
      setError(tErr("invalidBody"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/permissions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: trimmed,
          description: description.trim() || undefined,
        }),
      });

      if (res.ok) {
        router.push(`/${locale}/app/administrator/permissions`);
        router.refresh();
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
      <div className="space-y-2">
        <Label htmlFor="permission-key">{tFields("key")}</Label>
        <Input
          id="permission-key"
          type="text"
          required
          maxLength={120}
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="permission-description">{tFields("description")}</Label>
        <Input
          id="permission-description"
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
          onClick={() => router.push(`/${locale}/app/administrator/permissions`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
