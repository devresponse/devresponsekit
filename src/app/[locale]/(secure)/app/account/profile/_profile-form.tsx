"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { RequiredLegend } from "@/components/ui/required-legend";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { updateProfileSchema, type UpdateProfileInput } from "@/lib/validation/account";

/**
 * Profile editor (self-service; docs/form-validation.md). React Hook Form +
 * the shared `updateProfileSchema` (the same schema `/api/account/profile`
 * enforces). Email is read-only; the endpoint is self-scoped (no id sent).
 */
export interface ProfileFormProps {
  initial: { displayName: string; name: string; email: string };
}

export function ProfileForm({ initial }: ProfileFormProps) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [saved, setSaved] = useState(false);
  const form = useZodForm<UpdateProfileInput>(updateProfileSchema, {
    defaultValues: { name: initial.name, displayName: initial.displayName },
  });

  const onValid = async (values: UpdateProfileInput) => {
    form.clearErrors("root");
    setSaved(false);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: values.displayName?.trim() || null,
          name: values.name.trim(),
        }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      form.setError("root", {
        type: "server",
        message: res.status === 400 ? t("errors.invalid") : t("errors.saveFailed"),
      });
    } catch {
      form.setError("root", { type: "server", message: t("errors.saveFailed") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={updateProfileSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.name")}</FormLabel>
              <FormControl>
                <Input type="text" autoComplete="name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.displayName")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} value={field.value ?? ""} />
              </FormControl>
              <FormDescription>{t("fields.displayNameHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="space-y-2">
          <Label htmlFor="account-email">{t("fields.email")}</Label>
          <Input id="account-email" type="email" value={initial.email} readOnly disabled />
          <p className="text-muted-foreground text-xs">{t("fields.emailReadonlyHint")}</p>
        </div>

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}
        {saved ? (
          <p className="text-muted-foreground text-sm" role="status">
            {t("saved")}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={form.formState.isSubmitting}
            onClick={() => router.refresh()}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
