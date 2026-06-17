"use client";

import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RequiredLegend } from "@/components/ui/required-legend";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  organizationSettingsSchema,
  type OrganizationSettingsInput,
} from "@/lib/validation/organizations";

/**
 * Settings tab for the organization detail (docs/admin-manager.md §19;
 * docs/form-validation.md). React Hook Form + the shared
 * `organizationSettingsSchema`. Edits slug, name, status, and the default flag.
 */
export function OrganizationSettingsForm({
  orgId,
  initialSlug,
  initialName,
  initialStatus,
  initialIsDefault,
  canUpdate,
}: {
  orgId: string;
  initialSlug: string;
  initialName: string;
  initialStatus: string;
  initialIsDefault: boolean;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.settings");
  const tFields = useTranslations("administrator.orgs.fields");
  const tErr = useTranslations("administrator.errors");

  const [saved, setSaved] = useState(false);
  const form = useZodForm<OrganizationSettingsInput>(organizationSettingsSchema, {
    defaultValues: {
      slug: initialSlug,
      name: initialName,
      status: initialStatus as OrganizationSettingsInput["status"],
      isDefault: initialIsDefault,
    },
  });

  const onValid = async (values: OrganizationSettingsInput) => {
    form.clearErrors("root");
    setSaved(false);
    try {
      const res = await fetch(`/api/administrator/organizations/${orgId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: values.slug.trim(),
          name: values.name.trim(),
          status: values.status,
          isDefault: values.isDefault ?? false,
        }),
      });
      if (res.ok) {
        setSaved(true);
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
      form.setError("root", { type: "server", message: t("errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("errorToast") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={organizationSettingsSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        {canUpdate ? <RequiredLegend /> : null}

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("slug")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  {...field}
                  onChange={(e) => field.onChange(e.currentTarget.value.toLowerCase())}
                  disabled={!canUpdate}
                />
              </FormControl>
              <FormDescription>{tFields("slugHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("name")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} disabled={!canUpdate} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("status")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="active">{t("statusActive")}</SelectItem>
                  <SelectItem value="pending">{t("statusPending")}</SelectItem>
                  <SelectItem value="suspended">{t("statusSuspended")}</SelectItem>
                  <SelectItem value="archived">{t("statusArchived")}</SelectItem>
                </SelectContent>
              </Select>
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
                  disabled={!canUpdate}
                />
              </FormControl>
              <FormLabel className="font-normal">{tFields("isDefault")}</FormLabel>
            </FormItem>
          )}
        />

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}
        {saved ? (
          <p className="text-success text-sm" role="status">
            {t("saved")}
          </p>
        ) : null}

        <Button type="submit" disabled={!canUpdate || form.formState.isSubmitting}>
          {t("save")}
        </Button>
      </form>
    </Form>
  );
}
