"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/validation/auth";

export interface ResendVerificationFormProps {
  /** Localized path the verification link lands on after a successful verify. */
  callbackUrl: string;
  /** Optional pre-fill (e.g. the address typed into the sign-in form). */
  defaultEmail?: string;
}

/**
 * ResendVerificationForm
 *
 * Requests a fresh Better Auth email-verification link (React Hook Form + the
 * shared `forgotPasswordSchema`, which is email-only). Used by the verify-email
 * page and the sign-in "email not verified" recovery path.
 *
 * Anti-enumeration: the same neutral confirmation is shown regardless of the
 * Better Auth outcome (unknown address, already verified, or sent) — the
 * response never reveals whether an account exists or its verification state.
 * Only a thrown (network) error surfaces the generic failure message.
 */
export function ResendVerificationForm({
  callbackUrl,
  defaultEmail = "",
}: ResendVerificationFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const [done, setDone] = useState(false);
  const form = useZodForm<ForgotPasswordInput>(forgotPasswordSchema, {
    defaultValues: { email: defaultEmail },
  });

  const onValid = async (values: ForgotPasswordInput) => {
    form.clearErrors("root");
    try {
      // Intentionally ignore the { error } result: surfacing "already verified"
      // / "unknown address" would leak account state. Only a network throw is
      // treated as a failure.
      await authClient.sendVerificationEmail({ email: values.email, callbackURL: callbackUrl });
      setDone(true);
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

  if (done) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("verificationEmailSent")}
      </p>
    );
  }

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={forgotPasswordSchema}>
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

        {rootError ? (
          <p role="alert" className="text-destructive text-sm">
            {rootError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon("loading") : t("resendVerificationEmail")}
        </Button>
      </form>
    </Form>
  );
}
