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
import { LocaleLink } from "@/components/i18n/locale-link";
import { RequiredLegend } from "@/components/ui/required-legend";
import { authClient } from "@/lib/auth-client";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  resetPasswordFieldsSchema,
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/lib/validation/auth";

export interface ResetPasswordFormProps {
  locale: string;
  /** One-time token from the emailed reset link (`?token=`). */
  token: string | null;
}

/**
 * ResetPasswordForm
 *
 * Completes the Better Auth password-reset flow (React Hook Form + the shared
 * `resetPasswordSchema`). Validated with the refined schema (min length + the
 * new/confirm match, surfaced on confirm); the unrefined
 * `resetPasswordFieldsSchema` drives the required markers. The token is
 * single-use; an invalid/expired token shows a path back to request a fresh one.
 */
export function ResetPasswordForm({ locale, token }: ResetPasswordFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const [done, setDone] = useState(false);
  const form = useZodForm<ResetPasswordInput>(resetPasswordSchema, {
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onValid = async (values: ResetPasswordInput) => {
    form.clearErrors("root");
    try {
      const result = await authClient.resetPassword({
        newPassword: values.password,
        token: token as string,
      });
      if (result.error) {
        form.setError("root", { type: "server", message: t("resetTokenInvalid") });
      } else {
        setDone(true);
      }
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

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

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={resetPasswordFieldsSchema}>
      <form onSubmit={form.handleSubmit(onValid)} className="space-y-4" noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("newPassword")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("confirmPassword")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
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
          {form.formState.isSubmitting ? tCommon("loading") : t("setNewPassword")}
        </Button>
      </form>
    </Form>
  );
}
