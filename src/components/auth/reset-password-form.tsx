"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocaleLink } from "@/components/i18n/locale-link";
import { authClient } from "@/lib/auth-client";

export interface ResetPasswordFormProps {
  locale: string;
  /** One-time token from the emailed reset link (`?token=`). */
  token: string | null;
}

/**
 * ResetPasswordForm
 *
 * Completes the Better Auth password-reset flow with the one-time token
 * from the emailed link. Passwords live only in component state. The
 * token is single-use and short-lived; an invalid/expired token shows a
 * translated error with a path back to requesting a fresh link.
 */
export function ResetPasswordForm({ locale, token }: ResetPasswordFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("resetTokenInvalid")}{" "}
        <LocaleLink href="/forgot-password" locale={locale} className="underline">
          {t("requestNewResetLink")}
        </LocaleLink>
      </p>
    );
  }

  if (done) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("resetPasswordDone")}{" "}
        <LocaleLink href="/sign-in" locale={locale} className="underline">
          {tCommon("signIn")}
        </LocaleLink>
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }

    setPending(true);
    try {
      const result = await authClient.resetPassword({
        newPassword: password,
        token: token as string,
      });
      if (result.error) {
        setError(t("resetTokenInvalid"));
      } else {
        setDone(true);
      }
    } catch {
      setError(t("unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="new-password">{t("newPassword")}</Label>
        <Input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{t("confirmPassword")}</Label>
        <Input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tCommon("loading") : t("setNewPassword")}
      </Button>
    </form>
  );
}
