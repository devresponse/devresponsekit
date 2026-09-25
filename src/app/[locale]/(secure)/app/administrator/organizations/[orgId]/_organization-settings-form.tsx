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
import { useSavedFormBaseline } from "@/lib/forms/use-saved-form-baseline";
import {
  organizationSettingsSchema,
  type OrganizationSettingsInput,
} from "@/lib/validation/organizations";

/** The PATCH wire shape of the form, normalized the way the route stores it. */
function toOrganizationPatch(values: OrganizationSettingsInput) {
  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    status: values.status,
    isDefault: values.isDefault ?? false,
  };
}

/**
 * Settings tab for the organization detail (docs/admin-manager.md §8.2;
 * docs/form-validation.md). React Hook Form + the shared
 * `organizationSettingsSchema`. Edits slug, name, status, and the default flag.
 *
 * F-39: saves through `useSavedFormBaseline`. The PATCH carries only the
 * fields the admin changed, and a successful save moves the form's baseline
 * and refreshes the page, so coming back from another tab (which remounts
 * this form) can neither show nor re-send the pre-save status or name.
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
  const { form, changedBody, commitSaved } = useSavedFormBaseline<
    OrganizationSettingsInput,
    ReturnType<typeof toOrganizationPatch>
  >(
    organizationSettingsSchema,
    {
      slug: initialSlug,
      name: initialName,
      status: initialStatus as OrganizationSettingsInput["status"],
      isDefault: initialIsDefault,
    },
    toOrganizationPatch,
  );

  const onValid = async (values: OrganizationSettingsInput) => {
    form.clearErrors("root");
    setSaved(false);
    const changes = changedBody(values);
    if (!changes) {
      // Nothing differs from what is saved, so nothing is sent: an empty PATCH
      // would only write an audit row claiming an update.
      commitSaved(values);
      setSaved(true);
      return;
    }
    try {
      const res = await fetch(`/api/administrator/organizations/${orgId}`, {
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
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // F-09 + REVOKE-2: moving the org away from `active` would suspend the
        // platform's last superuser grant. Not a slug problem, so say so.
        if (body?.error === "last_superadmin") {
          form.setError("root", { type: "server", message: tErr("lastSuperadmin") });
          return;
        }
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
