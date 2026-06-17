"use client";

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
 * translated `auth.invalidCredentials` / `auth.unexpectedError` keys on the
 * form root, never leaking Better Auth codes.
 */
export function EmailPasswordLoginForm({ returnTo }: EmailPasswordLoginFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

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
        form.setError("root", { type: "server", message: t("invalidCredentials") });
      }
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

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
