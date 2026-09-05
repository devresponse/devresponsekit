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
import { useZodForm } from "@/lib/forms/use-zod-form";
import { createUserSchema, type CreateUserInput } from "@/lib/validation/users";
import { locales, LOCALE_LABELS } from "@/config/i18n-config";

/**
 * Client-side new-user form (docs/admin-manager.md §8.1; docs/form-validation.md).
 *
 * Reference implementation for the app-wide validation pattern: React Hook
 * Form + the SHARED `createUserSchema` (the same schema the API route
 * enforces — `@/lib/validation/users`). Required fields are marked with an
 * asterisk derived from the schema, invalid controls get a red border + a
 * field-level message, and server-only failures (409 email taken) map back
 * onto the offending field rather than a generic banner.
 */
const SELECT_CLASS =
  "border-input bg-background aria-invalid:border-destructive h-9 w-full rounded-md border px-2 text-sm";

export function NewUserForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.users");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreateUserInput>(createUserSchema, {
    defaultValues: {
      email: "",
      name: "",
      password: "",
      role: "user",
      initialAppStatus: "pending_approval",
      preferredLocale: "en",
    },
  });

  const onValid = async (values: CreateUserInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch("/api/administrator/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: values.email.trim(),
          password: values.password,
          name: values.name?.trim() || undefined,
          role: values.role,
          initialAppStatus: values.initialAppStatus,
          preferredLocale: values.preferredLocale,
        }),
      });

      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/users/${body.id}`
            : `/${locale}/app/administrator/users`,
        );
        router.refresh();
        return;
      }

      // Map server-only failures: a duplicate email lands on the email field;
      // everything else is a form-level banner (root).
      if (res.status === 409) {
        form.setError("email", { type: "server", message: tErr("emailTaken") });
        return;
      }
      if (res.status === 400) {
        form.setError("root", { type: "server", message: tErr("invalidBody") });
        return;
      }
      if (res.status === 403) {
        form.setError("root", { type: "server", message: tErr("forbidden") });
        return;
      }
      form.setError("root", { type: "server", message: t("new.errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("new.errorToast") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={createUserSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.email")}</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.displayName")}</FormLabel>
              <FormControl>
                <Input type="text" autoComplete="name" {...field} value={field.value ?? ""} />
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
              <FormLabel>{t("fields.password")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormDescription>{t("new.passwordHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.role")}</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field}>
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="initialAppStatus"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.initialAppStatus")}</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field}>
                    <option value="pending_approval">{t("status.pending_approval")}</option>
                    <option value="active">{t("status.active")}</option>
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="preferredLocale"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.preferredLocale")}</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field} value={field.value ?? "en"}>
                    {locales.map((l) => (
                      <option key={l} value={l}>
                        {LOCALE_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("new.submit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={form.formState.isSubmitting}
            onClick={() => router.push(`/${locale}/app/administrator/users`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
