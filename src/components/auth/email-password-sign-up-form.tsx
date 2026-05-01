"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export interface EmailPasswordSignUpFormProps {
  pendingApprovalHref: string;
}

/**
 * EmailPasswordSignUpForm
 *
 * Self-registration via Better Auth. Successful registrations move to the
 * localized pending-approval page immediately so the user never appears
 * stranded on the sign-up form after account creation.
 */
export function EmailPasswordSignUpForm({
  pendingApprovalHref,
}: EmailPasswordSignUpFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const router = useRouter();
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
        callbackURL: pendingApprovalHref,
      });
      if (result.error) {
        setError(t("unexpectedError"));
        return;
      }

      router.replace(pendingApprovalHref);
    } catch {
      setError(t("unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="name">{tCommon("displayName")}</Label>
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
