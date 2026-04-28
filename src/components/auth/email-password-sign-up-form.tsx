"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export interface EmailPasswordSignUpFormProps {
  returnTo: string;
}

/**
 * EmailPasswordSignUpForm
 *
 * Self-registration via Better Auth. The created user is provisioned in
 * a `pending_approval` state by the application provisioning service —
 * the form intentionally redirects to the localized pending-approval
 * page instead of the dashboard so the user does not see a flash of
 * secure UI before being blocked by the secure layout guard.
 */
export function EmailPasswordSignUpForm({ returnTo }: EmailPasswordSignUpFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await authClient.signUp.email({
        email,
        password,
        name,
        callbackURL: returnTo,
      });
      if (result.error) {
        setError(t("unexpectedError"));
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
        <Label htmlFor="name">{tCommon("appName")}</Label>
        <Input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

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
          autoComplete="new-password"
          required
          minLength={8}
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
        {pending ? tCommon("loading") : t("createAccount")}
      </Button>
    </form>
  );
}
