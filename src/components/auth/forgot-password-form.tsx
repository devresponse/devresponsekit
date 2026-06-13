"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export interface ForgotPasswordFormProps {
  /** Localized path the reset link in the email lands on. */
  redirectTo: string;
}

/**
 * ForgotPasswordForm
 *
 * Requests a Better Auth password-reset email. The server renders and
 * records the email through the outbox pipeline (specs.md §35).
 *
 * Anti-enumeration: Better Auth returns success whether or not the
 * address exists, and this form shows the same confirmation either way
 * — it never reveals whether an account exists.
 */
export function ForgotPasswordForm({ redirectTo }: ForgotPasswordFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo,
      });
      if (result.error) {
        setError(t("unexpectedError"));
      } else {
        setDone(true);
      }
    } catch {
      setError(t("unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("resetEmailSent")}
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-muted-foreground text-sm">{t("forgotPasswordDescription")}</p>
      <div className="space-y-2">
        <Label htmlFor="email">{tCommon("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending || email.trim().length === 0}>
        {pending ? tCommon("loading") : t("sendResetLink")}
      </Button>
    </form>
  );
}
