"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RequiredLegend } from "@/components/ui/required-legend";
import { authClient } from "@/lib/auth-client";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { signInSchema, type SignInInput } from "@/lib/validation/auth";

export interface EmailPasswordLoginFormProps {
  /** Sanitized localized return path. Set by the parent server component. */
  returnTo: string;
}

/**
 * EmailPasswordLoginForm
 *
 * Client-side Better Auth email/password sign-in (React Hook Form + the shared
 * `signInSchema`). Credentials live only in form state. Errors surface via the
 * translated `auth.invalidCredentials` / `auth.blockedDescription` (a banned
 * account, F-153) / `errors.rate_limited` (a 429, F-55) /
 * `auth.unexpectedError` keys on the form root, never leaking Better Auth
 * codes.
 */
export function EmailPasswordLoginForm({ returnTo }: EmailPasswordLoginFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  // Set when Better Auth rejects sign-in with EMAIL_NOT_VERIFIED (AUTH-4).
  // Swaps the form for a verify + resend prompt, pre-filled with the address.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  const form = useZodForm<SignInInput>(signInSchema, {
    defaultValues: { email: "", password: "" },
  });

  const onValid = async (values: SignInInput) => {
    form.clearErrors("root");
    try {
      const result = await authClient.signIn.email({
        email: values.email,
        password: values.password,
        callbackURL: returnTo,
      });
      if (result.error) {
        const code = "code" in result.error ? result.error.code : undefined;
        // EMAIL_NOT_VERIFIED (403) means the credentials were correct but the
        // address is unverified — route to the resend prompt rather than the
        // generic "invalid credentials", which would be misleading. Matched by
        // code (not status): a banned sign-in is a 403 too.
        if (code === "EMAIL_NOT_VERIFIED") {
          setUnverifiedEmail(values.email);
          return;
        }
        // F-153: BANNED_USER (403) is a correct password on a banned account,
        // a soft-deleted one included. It said "Invalid email or password.",
        // so a password reset looked like the fix and changed nothing. Say the
        // account is restricted instead, as the blocked page does. Better Auth
        // checks the ban only after the password, so this tells nothing to
        // someone who does not know it.
        // F-55: a 429 is the per-IP limit or the per-account budget, which a
        // guessing run against this address can spend. "Invalid email or
        // password" would send its owner to a reset that changes nothing; say
        // to wait instead. Both limits refuse every address alike, so this
        // reveals no account.
        const message =
          result.error.status === 429
            ? tErrors("rate_limited")
            : code === "BANNED_USER"
              ? t("blockedDescription")
              : t("invalidCredentials");
        form.setError("root", { type: "server", message });
      }
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

  if (unverifiedEmail) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>{t("verifyEmailTitle")}</AlertTitle>
          <AlertDescription>{t("emailNotVerified")}</AlertDescription>
        </Alert>
        <ResendVerificationForm callbackUrl={returnTo} defaultEmail={unverifiedEmail} />
      </div>
    );
  }

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={signInSchema}>
      <form onSubmit={form.handleSubmit(onValid)} className="space-y-4" noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tCommon("email")}</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tCommon("password")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {rootError ? (
          <p role="alert" className="text-destructive text-sm">
            {rootError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon("loading") : tCommon("signIn")}
        </Button>
      </form>
    </Form>
  );
}
