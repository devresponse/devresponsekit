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
import { useSavedFormBaseline } from "@/lib/forms/use-saved-form-baseline";
import { groupSettingsSchema, type GroupSettingsInput } from "@/lib/validation/groups";

/** The PATCH wire shape of the form, normalized the way the route stores it. */
function toGroupPatch(values: GroupSettingsInput) {
  return {
    name: values.name.trim(),
    description: values.description?.trim() ? values.description.trim() : null,
  };
}

/**
 * Settings tab for the group detail (ADR-0002; docs/form-validation.md).
 * React Hook Form + the shared `groupSettingsSchema`. Edits name + description;
 * the `key` is read-only (referenced by audit metadata).
 *
 * F-39: saves through `useSavedFormBaseline`, exactly as the role Settings tab
 * does: only the changed fields are sent (an empty PATCH is a 400
 * `no_changes`, so nothing is sent), and a successful save moves the baseline
 * and refreshes the page.
 */
export function GroupSettingsForm({
  groupId,
  initialKey,
  initialName,
  initialDescription,
  canUpdate,
}: {
  groupId: string;
  initialKey: string;
  initialName: string;
  initialDescription: string | null;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.groups.settings");
  const tFields = useTranslations("administrator.groups.fields");
  const tErr = useTranslations("administrator.errors");

  const [saved, setSaved] = useState(false);
  const { form, changedBody, commitSaved } = useSavedFormBaseline<
    GroupSettingsInput,
    ReturnType<typeof toGroupPatch>
  >(
    groupSettingsSchema,
    { name: initialName, description: initialDescription ?? "" },
    toGroupPatch,
  );

  const onValid = async (values: GroupSettingsInput) => {
    form.clearErrors("root");
    setSaved(false);
    const changes = changedBody(values);
    if (!changes) {
      commitSaved(values);
      setSaved(true);
      return;
    }
    try {
      const res = await fetch(`/api/administrator/groups/${groupId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (res.ok) {
        commitSaved(values);
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
    <Form {...form} schema={groupSettingsSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        {canUpdate ? <RequiredLegend /> : null}

        <div className="space-y-2">
          <Label htmlFor="group-key-readonly">{tFields("key")}</Label>
          <Input id="group-key-readonly" type="text" readOnly value={initialKey} />
          <p className="text-muted-foreground text-xs">{t("keyReadOnly")}</p>
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
