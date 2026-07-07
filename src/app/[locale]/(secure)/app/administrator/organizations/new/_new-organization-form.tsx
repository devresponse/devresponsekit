"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  createOrganizationSchema,
  type CreateOrganizationInput,
} from "@/lib/validation/organizations";

/**
 * Client-side new-organization form (docs/admin-manager.md §8.2;
 * docs/form-validation.md). React Hook Form + the shared
 * `createOrganizationSchema` (same schema the API route enforces): required
 * markers on slug/name, field-level errors with a red border, and a 409
 * mapped onto the slug field.
 */
export function NewOrganizationForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.orgs");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreateOrganizationInput>(createOrganizationSchema, {
    defaultValues: { slug: "", name: "", isDefault: false },
  });

  const onValid = async (values: CreateOrganizationInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch("/api/administrator/organizations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: values.slug.trim(),
          name: values.name.trim(),
          isDefault: values.isDefault ?? false,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/organizations/${body.id}`
            : `/${locale}/app/administrator/organizations`,
        );
        router.refresh();
        return;
      }
      if (res.status === 409) {
        form.setError("slug", { type: "server", message: tErr("slugTaken") });
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
    <Form {...form} schema={createOrganizationSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.slug")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  {...field}
                  // Slugs are lowercase; normalize as the user types.
                  onChange={(e) => field.onChange(e.currentTarget.value.toLowerCase())}
                />
              </FormControl>
              <FormDescription>{t("fields.slugHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.name")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isDefault"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value ?? false}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
              </FormControl>
              <FormLabel className="font-normal">{t("fields.isDefault")}</FormLabel>
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
            onClick={() => router.push(`/${locale}/app/administrator/organizations`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
