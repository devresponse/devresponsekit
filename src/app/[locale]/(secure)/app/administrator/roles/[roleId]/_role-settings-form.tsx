"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { RequiredLegend } from "@/components/ui/required-legend";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { roleSettingsSchema, type RoleSettingsInput } from "@/lib/validation/roles";

/**
 * Settings tab for the role detail (docs/admin-manager.md §8.4;
 * docs/form-validation.md). React Hook Form + the shared `roleSettingsSchema`
 * (a `name`-required view of the route's partial PATCH contract).
 *
 * The key is shown read-only — roles are referenced by key in audit metadata
 * and policy lookups, so a rename would silently break them.
 */
export function RoleSettingsForm({
  roleId,
  initialKey,
  initialName,
  initialDescription,
  canUpdate,
}: {
  roleId: string;
  initialKey: string;
  initialName: string;
  initialDescription: string | null;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.roles.settings");
  const tFields = useTranslations("administrator.roles.fields");
  const tErr = useTranslations("administrator.errors");

  const [saved, setSaved] = useState(false);
  const form = useZodForm<RoleSettingsInput>(roleSettingsSchema, {
    defaultValues: { name: initialName, description: initialDescription ?? "" },
  });

  const onValid = async (values: RoleSettingsInput) => {
    form.clearErrors("root");
    setSaved(false);
    try {
      const res = await fetch(`/api/administrator/roles/${roleId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description?.trim() ? values.description.trim() : null,
        }),
      });
      if (res.ok) {
        setSaved(true);
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
    <Form {...form} schema={roleSettingsSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        {canUpdate ? <RequiredLegend /> : null}

        <div className="space-y-2">
          <Label htmlFor="role-key-readonly">{tFields("key")}</Label>
          <Input
            id="role-key-readonly"
            type="text"
            readOnly
            value={initialKey}
            aria-describedby="key-readonly-hint"
          />
          <p id="key-readonly-hint" className="text-muted-foreground text-xs">
            {t("keyReadOnly")}
          </p>
        </div>

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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tFields("description")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} value={field.value ?? ""} disabled={!canUpdate} />
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
