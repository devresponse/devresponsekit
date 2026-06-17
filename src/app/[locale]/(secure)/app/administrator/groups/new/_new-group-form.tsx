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
import { createGroupSchema, type CreateGroupInput } from "@/lib/validation/groups";
import { OrganizationPicker } from "../../_components/organization-picker";

/**
 * Client-side new-group form (ADR-0002; docs/form-validation.md). React Hook
 * Form + the shared `createGroupSchema` (same schema the API route enforces).
 *
 * Groups are ALWAYS org-scoped:
 *   - an ORG ADMIN's group is created in their own org server-side, so no
 *     picker is shown and `organizationId` is omitted;
 *   - a SUPERADMIN must choose the target org via {@link OrganizationPicker}
 *     (no Global option) — required, enforced here on submit.
 */
export function NewGroupForm({
  locale,
  showOrgPicker,
}: {
  locale: string;
  showOrgPicker: boolean;
}) {
  const t = useTranslations("administrator.groups");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreateGroupInput>(createGroupSchema, {
    defaultValues: { key: "", name: "", description: "", organizationId: undefined },
  });

  const onValid = async (values: CreateGroupInput) => {
    form.clearErrors("root");
    // A SUPERADMIN must pick a target org (groups are never global).
    if (showOrgPicker && !values.organizationId) {
      form.setError("organizationId", { type: "manual", message: t("new.organizationRequired") });
      return;
    }
    try {
      const res = await fetch("/api/administrator/groups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: values.key.trim(),
          name: values.name.trim(),
          description: values.description?.trim() || undefined,
          // Org admins omit this — the server forces their own org.
          ...(showOrgPicker ? { organizationId: values.organizationId } : {}),
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/groups/${body.id}`
            : `/${locale}/app/administrator/groups`,
        );
        router.refresh();
        return;
      }
      if (res.status === 409) {
        form.setError("key", { type: "server", message: tErr("keyTaken") });
        return;
      }
      if (res.status === 400) {
        form.setError("root", { type: "server", message: t("new.organizationRequired") });
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
    <Form {...form} schema={createGroupSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        {showOrgPicker ? (
          <FormField
            control={form.control}
            name="organizationId"
            render={({ field }) => (
              <FormItem>
                <OrganizationPicker
                  id="group-organization"
                  value={field.value ?? null}
                  onChange={field.onChange}
                />
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <FormField
          control={form.control}
          name="key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.key")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} />
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.description")}</FormLabel>
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
            onClick={() => router.push(`/${locale}/app/administrator/groups`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
