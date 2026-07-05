"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
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
  /**
   * Invitation secret riding the sign-up body (0008). The server pre-verifies
   * the account when the token matches this email and places it active in
   * the inviting organization.
   */
  invitationToken?: string;
  /** The invited address; when set the email field is pre-filled and locked. */
  invitedEmail?: string;
}

/**
 * EmailPasswordSignUpForm
 *
 * Self-registration via Better Auth (React Hook Form + the shared
 * `signUpSchema`). The workflow follows the organization's signup policy
 * (app_organization_auth_settings, 0007):
 *
 *   - Verification required (the fail-closed default, AUTH-4): sign-up
 *     creates the account and emails a verification link but does NOT start
 *     a session, so on success the user is sent to the localized
 *     verify-email page. Clicking the emailed link verifies the address and
 *     lands them at `postVerifyHref`.
 *   - Verification waived by the org: the server pre-verifies the account at
 *     creation (visible as `user.emailVerified` in the sign-up response).
 *     Sign-up still never starts a session while the global
 *     `requireEmailVerification` baseline is on, so the form signs in
 *     immediately with the just-submitted credentials; Better Auth then
 *     redirects to `postVerifyHref` via its `callbackURL` handling.
 */
export function EmailPasswordSignUpForm({
  verifyEmailHref,
  postVerifyHref,
  invitationToken,
  invitedEmail,
}: EmailPasswordSignUpFormProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const form = useZodForm<SignUpInput>(signUpSchema, {
    defaultValues: { name: "", email: invitedEmail ?? "", password: "" },
  });

  const onValid = async (values: SignUpInput) => {
    form.clearErrors("root");
    try {
      // The invitation token is an EXTRA body field: better-auth's sign-up
      // schema accepts an open record and the server hooks read it from
      // `context.body` (the same channel as `callbackURL`), so the client
      // type is cast to admit it.
      const payload = {
        email: values.email,
        password: values.password,
        name: values.name.trim(),
        callbackURL: postVerifyHref,
        ...(invitationToken ? { invitationToken } : {}),
      };
      const result = await authClient.signUp.email(
        payload as Parameters<typeof authClient.signUp.email>[0],
      );
      if (result.error) {
        form.setError("root", { type: "server", message: t("unexpectedError") });
        return;
      }
      if (result.data?.user?.emailVerified) {
        // The org's policy waived verification (the account arrived
        // pre-verified), so sign in with the just-submitted credentials —
        // Better Auth redirects to `callbackURL` on success. Only attempted
        // when it is known to pass, so no stray verification email is ever
        // triggered by a doomed sign-in.
        const signInResult = await authClient.signIn.email({
          email: values.email,
          password: values.password,
          callbackURL: postVerifyHref,
        });
        if (signInResult.error) {
          // The account exists and is verified; the page's "have an
          // account?" link offers manual sign-in as the recovery path.
          form.setError("root", { type: "server", message: t("unexpectedError") });
        }
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
                <Input type="email" autoComplete="email" {...field} disabled={!!invitedEmail} />
              </FormControl>
              {invitedEmail ? <FormDescription>{t("invitedEmailLocked")}</FormDescription> : null}
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
