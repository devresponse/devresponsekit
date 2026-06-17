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
import { createRoleSchema, type CreateRoleInput } from "@/lib/validation/roles";
import { OrganizationPicker } from "../../_components/organization-picker";

/**
 * Client-side new-role form (plan §8.5; docs/form-validation.md). React Hook
 * Form + the shared `createRoleSchema` (same schema the API route enforces):
 * schema-derived required markers, field-level errors with a red border, and
 * a 409 mapped onto the key field.
 *
 * Scope (ADR-0001):
 *   - a SUPERADMIN may create a Global role or scope it to any org, so the
 *     {@link OrganizationPicker} is shown with the Global option;
 *   - an ORG ADMIN may only create a role in their own org, so no picker is
 *     shown and `defaultOrganizationId` (their org) is submitted — a global
 *     role would be rejected with 403.
 */
export function NewRoleForm({
  locale,
  showOrgPicker,
  defaultOrganizationId,
}: {
  locale: string;
  showOrgPicker: boolean;
  defaultOrganizationId: string | null;
}) {
  const t = useTranslations("administrator.roles");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreateRoleInput>(createRoleSchema, {
    defaultValues: {
      key: "",
      name: "",
      description: "",
      organizationId: defaultOrganizationId,
    },
  });

  const onValid = async (values: CreateRoleInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch("/api/administrator/roles", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: values.key.trim(),
          name: values.name.trim(),
          description: values.description?.trim() || undefined,
          organizationId: values.organizationId ?? null,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/roles/${body.id}`
            : `/${locale}/app/administrator/roles`,
        );
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
    <Form {...form} schema={createRoleSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        {showOrgPicker ? (
          <FormField
            control={form.control}
            name="organizationId"
            render={({ field }) => (
              // The picker renders its own label and manages a valid value
              // (an org id or null for Global), so it isn't a FormControl child.
              <OrganizationPicker
                id="role-organization"
                includeGlobal
                value={field.value ?? null}
                onChange={field.onChange}
              />
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
            onClick={() => router.push(`/${locale}/app/administrator/roles`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
