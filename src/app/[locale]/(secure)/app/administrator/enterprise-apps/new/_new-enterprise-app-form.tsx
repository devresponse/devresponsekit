"use client";

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
import { RequiredLegend } from "@/components/ui/required-legend";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  createEnterpriseAppSchema,
  type CreateEnterpriseAppInput,
} from "@/lib/validation/enterprise-apps";

/**
 * Client-side new enterprise application form (docs/admin-manager.md §8.7;
 * docs/form-validation.md). React Hook Form + the shared
 * `createEnterpriseAppSchema` (same schema the API route enforces):
 * schema-derived required markers, field-level errors with a red border.
 *
 * `origin` HTTPS / trusted-suffix checks are server-only (env-driven), so a
 * non-HTTPS or untrusted origin comes back as `invalid_origin` /
 * `origin_not_allowed` and is mapped onto the origin field. The app `id` is a
 * stable text primary key (not editable later), so it's chosen carefully here.
 */
export function NewEnterpriseAppForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const form = useZodForm<CreateEnterpriseAppInput>(createEnterpriseAppSchema, {
    defaultValues: {
      id: "",
      label: "",
      description: "",
      origin: "",
      subdomain: "",
      sso_audience: "",
      sort_order: 100,
    },
  });

  const onValid = async (values: CreateEnterpriseAppInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch("/api/administrator/enterprise-apps", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: values.id.trim(),
          label: values.label.trim(),
          description: values.description?.trim() ? values.description.trim() : null,
          origin: values.origin.trim(),
          subdomain: values.subdomain.trim(),
          sso_audience: values.sso_audience.trim(),
          sort_order: values.sort_order,
        }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        router.push(
          body.id
            ? `/${locale}/app/administrator/enterprise-apps/${encodeURIComponent(body.id)}`
            : `/${locale}/app/administrator/enterprise-apps`,
        );
        router.refresh();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "id_taken") {
          form.setError("id", { type: "server", message: tErr("idTaken") });
        } else {
          form.setError("root", { type: "server", message: t("new.errorToast") });
        }
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
      form.setError("root", { type: "server", message: t("new.errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("new.errorToast") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={createEnterpriseAppSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.id")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  {...field}
                  onChange={(e) => field.onChange(e.currentTarget.value.toLowerCase())}
                />
              </FormControl>
              <FormDescription>{t("fields.idHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.label")}</FormLabel>
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

        <FormField
          control={form.control}
          name="origin"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.origin")}</FormLabel>
              <FormControl>
                <Input type="url" placeholder="https://example.com" {...field} />
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
                <Input type="text" {...field} />
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
                  // Bind a real number (or undefined when cleared) so the
                  // schema's `z.number()` validates the actual value.
                  onChange={(e) =>
                    field.onChange(
                      e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber,
                    )
                  }
                />
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
            onClick={() => router.push(`/${locale}/app/administrator/enterprise-apps`)}
          >
            {t("new.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
