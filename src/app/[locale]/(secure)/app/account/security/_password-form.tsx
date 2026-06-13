"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * Password change (self-service) via Better Auth's client. Better Auth
 * verifies the current password and owns the hashing — this form never
 * sees or stores a hash. `revokeOtherSessions` signs out other devices
 * on success, which is the safe default after a credential change.
 */
export function PasswordForm() {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (next.length < 8) {
      setError(t("errors.passwordTooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("errors.passwordMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (res.error) {
        setError(t("errors.passwordChangeFailed"));
        return;
      }
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      setError(t("errors.passwordChangeFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="current-password">{t("security.currentPassword")}</Label>
        <Input
          id="current-password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password">{t("security.newPassword")}</Label>
        <Input
          id="new-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">{t("security.confirmPassword")}</Label>
        <Input
          id="confirm-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("security.passwordChanged")}
        </p>
      ) : null}

      <Button type="submit" disabled={submitting || current.length === 0}>
        {submitting ? tCommon("loading") : t("security.changePassword")}
      </Button>
    </form>
  );
}
