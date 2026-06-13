"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Profile editor (self-service).
 *
 * Controlled inputs with client validation mirroring the server Zod
 * schema (`/api/account/profile`), which stays the source of truth.
 * Submit + Cancel at the bottom, no back link (project rule). Email is
 * displayed read-only. The endpoint is self-scoped — it always writes
 * the session user's own row — so the form sends no identifier.
 */
export interface ProfileFormProps {
  initial: { displayName: string; name: string; email: string };
}

export function ProfileForm({ initial }: ProfileFormProps) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [displayName, setDisplayName] = useState(initial.displayName);
  const [name, setName] = useState(initial.name);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saved">("idle");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setStatus("idle");

    if (name.trim().length === 0) {
      setError(t("errors.nameRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          name: name.trim(),
        }),
      });
      if (res.ok) {
        setStatus("saved");
        router.refresh();
        return;
      }
      setError(res.status === 400 ? t("errors.invalid") : t("errors.saveFailed"));
    } catch {
      setError(t("errors.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="account-name">{t("fields.name")}</Label>
        <Input
          id="account-name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="account-display-name">{t("fields.displayName")}</Label>
        <Input
          id="account-display-name"
          type="text"
          maxLength={120}
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <p className="text-muted-foreground text-xs">{t("fields.displayNameHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="account-email">{t("fields.email")}</Label>
        <Input id="account-email" type="email" value={initial.email} readOnly disabled />
        <p className="text-muted-foreground text-xs">{t("fields.emailReadonlyHint")}</p>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {status === "saved" ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("saved")}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.refresh()}
        >
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
