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
import { authClient } from "@/lib/auth-client";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  changePasswordSchema,
  passwordFieldsSchema,
  type ChangePasswordInput,
} from "@/lib/validation/account";

/**
 * Password change (self-service; docs/form-validation.md) via Better Auth's
 * client — it verifies the current password and owns the hashing, so this form
 * never sees a hash. `revokeOtherSessions` signs out other devices on success.
 *
 * React Hook Form validates with `changePasswordSchema` (min length + the
 * new/confirm match, surfaced on the confirm field); the unrefined
 * `passwordFieldsSchema` drives the required markers (a `.refine()` object has
 * no `.shape` for asterisk derivation).
 */
export function PasswordForm() {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");

  const [done, setDone] = useState(false);
  const form = useZodForm<ChangePasswordInput>(changePasswordSchema, {
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onValid = async (values: ChangePasswordInput) => {
    form.clearErrors("root");
    setDone(false);
    try {
      const res = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      });
      if (res.error) {
        form.setError("root", { type: "server", message: t("errors.passwordChangeFailed") });
        return;
      }
      setDone(true);
      form.reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } catch {
      form.setError("root", { type: "server", message: t("errors.passwordChangeFailed") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={passwordFieldsSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("security.currentPassword")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("security.newPassword")}</FormLabel>
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
              <FormLabel>{t("security.confirmPassword")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}
        {done ? (
          <p className="text-muted-foreground text-sm" role="status">
            {t("security.passwordChanged")}
          </p>
        ) : null}

        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon("loading") : t("security.changePassword")}
        </Button>
      </form>
    </Form>
  );
}
