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
import { APP_STATUS_VALUES } from "@/lib/admin/enterprise-apps";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  enterpriseAppSettingsSchema,
  type EnterpriseAppSettingsInput,
} from "@/lib/validation/enterprise-apps";

/**
 * Enterprise application settings form (docs/admin-manager.md §8.10;
 * docs/form-validation.md). React Hook Form + the shared
 * `enterpriseAppSettingsSchema`. The `id` is immutable (not editable here).
 * Read-only when the caller lacks `admin.apps.manage`.
 *
 * HTTPS / trusted-suffix origin checks are server-only and surface as
 * `invalid_origin` / `origin_not_allowed`, mapped onto the origin field.
 */
export interface EnterpriseAppSettingsValue {
  id: string;
  label: string;
  description: string | null;
  origin: string;
  subdomain: string;
  ssoAudience: string;
  status: string;
  sortOrder: number;
  organizationSlug: string | null;
}

const SELECT_CLASS =
  "border-input bg-background aria-invalid:border-destructive h-9 w-full rounded-md border px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";

export function EnterpriseAppSettingsForm({
  app,
  canManage,
}: {
  app: EnterpriseAppSettingsValue;
  canManage: boolean;
}) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [saved, setSaved] = useState(false);
  const form = useZodForm<EnterpriseAppSettingsInput>(enterpriseAppSettingsSchema, {
    defaultValues: {
      label: app.label,
      description: app.description ?? "",
      origin: app.origin,
      subdomain: app.subdomain,
      sso_audience: app.ssoAudience,
      status: app.status as EnterpriseAppSettingsInput["status"],
      sort_order: app.sortOrder,
    },
  });

  const onValid = async (values: EnterpriseAppSettingsInput) => {
    form.clearErrors("root");
    setSaved(false);
    try {
      const res = await fetch(`/api/administrator/enterprise-apps/${encodeURIComponent(app.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: values.label.trim(),
          description: values.description?.trim() ? values.description.trim() : null,
          origin: values.origin.trim(),
          subdomain: values.subdomain.trim(),
          sso_audience: values.sso_audience.trim(),
          status: values.status,
          sort_order: values.sort_order,
        }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "invalid_origin") {
          form.setError("origin", { type: "server", message: tErr("invalidOrigin") });
        } else if (body.error === "origin_not_allowed") {
          form.setError("origin", { type: "server", message: tErr("originNotAllowed") });
        } else {
          form.setError("root", { type: "server", message: tErr("invalidBody") });
        }
        return;
      }
      if (res.status === 403) {
        form.setError("root", { type: "server", message: tErr("forbidden") });
        return;
      }
      if (res.status === 404) {
        form.setError("root", { type: "server", message: tErr("notFound") });
        return;
      }
      form.setError("root", { type: "server", message: t("settings.errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("settings.errorToast") });
    }
  };

  const rootError = form.formState.errors.root?.message;
  const disabled = !canManage || form.formState.isSubmitting;

  return (
    <Form {...form} schema={enterpriseAppSettingsSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        {canManage ? <RequiredLegend /> : null}

        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.label")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} disabled={disabled} />
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
                <Input type="text" {...field} value={field.value ?? ""} disabled={disabled} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="origin"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.origin")}</FormLabel>
              <FormControl>
                <Input type="url" {...field} disabled={disabled} />
              </FormControl>
              <FormDescription>{t("fields.originHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="subdomain"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.subdomain")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  {...field}
                  onChange={(e) => field.onChange(e.currentTarget.value.toLowerCase())}
                  disabled={disabled}
                />
              </FormControl>
              <FormDescription>{t("fields.subdomainHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sso_audience"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.ssoAudience")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} disabled={disabled} />
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
              <FormLabel>{t("fields.status")}</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field} disabled={disabled}>
                  {APP_STATUS_VALUES.map((s) => (
                    <option key={s} value={s}>
                      {t(`status.${s}`)}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sort_order"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.sortOrder")}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(
                      e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber,
                    )
                  }
                  disabled={disabled}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="space-y-2">
          <Label>{t("fields.organization")}</Label>
          <p className="text-foreground text-sm">
            {app.organizationSlug ? (
              <code className="text-xs">{app.organizationSlug}</code>
            ) : (
              <span className="text-muted-foreground">{t("global")}</span>
            )}
          </p>
        </div>

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}
        {saved ? (
          <p className="text-success text-sm" role="status">
            {t("settings.saved")}
          </p>
        ) : null}

        {canManage ? (
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("settings.save")}
          </Button>
        ) : null}
      </form>
    </Form>
  );
}
