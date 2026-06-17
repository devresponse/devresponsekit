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
import { useZodForm } from "@/lib/forms/use-zod-form";
import { createPermissionSchema, type CreatePermissionInput } from "@/lib/validation/permissions";

/**
 * Client-side new-permission form (plan §8.7; docs/form-validation.md).
 * React Hook Form + the shared `createPermissionSchema` (the same schema the
 * API route enforces): schema-derived required marker, field-level errors with
 * a red border, and a 409 mapped onto the key field.
 */
export function NewPermissionForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.permissions");
  const tFields = useTranslations("administrator.permissions.fields");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreatePermissionInput>(createPermissionSchema, {
    defaultValues: { key: "", description: "" },
  });

  const onValid = async (values: CreatePermissionInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch("/api/administrator/permissions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: values.key.trim(),
          description: values.description?.trim() || undefined,
        }),
      });
      if (res.ok) {
        router.push(`/${locale}/app/administrator/permissions`);
        router.refresh();
        return;
      }
      if (res.status === 409) {
        form.setError("key", { type: "server", message: tErr("keyTaken") });
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
    <Form {...form} schema={createPermissionSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("key")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("description")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} value={field.value ?? ""} />
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

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("new.submit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={form.formState.isSubmitting}
            onClick={() => router.push(`/${locale}/app/administrator/permissions`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
