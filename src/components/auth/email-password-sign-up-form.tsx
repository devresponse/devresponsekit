"use client";

import { useRouter } from "next/navigation";
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
import { signUpSchema, type SignUpInput } from "@/lib/validation/auth";

export interface EmailPasswordSignUpFormProps {
  /** Localized "check your inbox" page shown immediately after sign-up. */
  verifyEmailHref: string;
  /** Post-verification destination, carried as the Better Auth `callbackURL`. */
  postVerifyHref: string;
}

/**
 * EmailPasswordSignUpForm
 *
 * Self-registration via Better Auth (React Hook Form + the shared
 * `signUpSchema`). Email verification is required (AUTH-4): sign-up creates the
 * account and emails a verification link but does NOT start a session, so on
 * success the user is sent to the localized verify-email page. Clicking the
 * emailed link verifies the address and lands them at `postVerifyHref`.
 */
export function EmailPasswordSignUpForm({
  verifyEmailHref,
  postVerifyHref,
}: EmailPasswordSignUpFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const form = useZodForm<SignUpInput>(signUpSchema, {
    defaultValues: { name: "", email: "", password: "" },
  });

  const onValid = async (values: SignUpInput) => {
    form.clearErrors("root");
    try {
      const result = await authClient.signUp.email({
        email: values.email,
        password: values.password,
        name: values.name.trim(),
        callbackURL: postVerifyHref,
      });
      if (result.error) {
        form.setError("root", { type: "server", message: t("unexpectedError") });
        return;
      }
      router.replace(verifyEmailHref);
    } catch {
      form.setError("root", { type: "server", message: t("unexpectedError") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={signUpSchema}>
      <form onSubmit={form.handleSubmit(onValid)} className="space-y-4" noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tCommon("displayName")}</FormLabel>
              <FormControl>
                <Input type="text" autoComplete="name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
          {form.formState.isSubmitting ? tCommon("loading") : t("createAccount")}
        </Button>
      </form>
    </Form>
  );
}
