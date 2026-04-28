"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export interface EmailPasswordLoginFormProps {
  /** Sanitized localized return path. Set by the parent server component. */
  returnTo: string;
}

/**
 * EmailPasswordLoginForm
 *
 * Client-side Better Auth email/password sign-in. Credentials live only in
 * component state (never persisted, never logged). The component surfaces
 * error messages via the translated `auth.invalidCredentials` /
 * `auth.unexpectedError` keys to avoid leaking internal Better Auth codes.
 */
export function EmailPasswordLoginForm({ returnTo }: EmailPasswordLoginFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: returnTo,
      });

      if (result.error) {
        setError(t("invalidCredentials"));
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

      <div className="space-y-2">
        <Label htmlFor="password">{tCommon("password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tCommon("loading") : tCommon("signIn")}
      </Button>
    </form>
  );
}
