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

export interface ForgotPasswordFormProps {
  /** Localized path the reset link in the email lands on. */
  redirectTo: string;
}

/**
 * ForgotPasswordForm
 *
 * Requests a Better Auth password-reset email (React Hook Form + the shared
 * `forgotPasswordSchema`). Anti-enumeration: Better Auth returns success
 * whether or not the address exists, and this form shows the same
 * confirmation either way.
 */
export function ForgotPasswordForm({ redirectTo }: ForgotPasswordFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const [done, setDone] = useState(false);
  const form = useZodForm<ForgotPasswordInput>(forgotPasswordSchema, {
    defaultValues: { email: "" },
  });

  const onValid = async (values: ForgotPasswordInput) => {
    form.clearErrors("root");
    try {
      const result = await authClient.requestPasswordReset({ email: values.email, redirectTo });
      if (result.error) {
        form.setError("root", { type: "server", message: t("unexpectedError") });
      } else {
        setDone(true);
      }
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

  if (done) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("resetEmailSent")}
      </p>
    );
  }

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={forgotPasswordSchema}>
      <form onSubmit={form.handleSubmit(onValid)} className="space-y-4" noValidate>
        <p className="text-muted-foreground text-sm">{t("forgotPasswordDescription")}</p>
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
          {form.formState.isSubmitting ? tCommon("loading") : t("sendResetLink")}
        </Button>
      </form>
    </Form>
  );
}
