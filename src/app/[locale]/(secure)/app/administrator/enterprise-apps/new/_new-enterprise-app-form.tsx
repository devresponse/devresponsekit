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
import {
  DEFAULT_SSO_AUDIENCE_PREFIX,
  isConsumableAudienceFor,
  isOrgNamespacedAppId,
} from "@/lib/admin/enterprise-apps";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  createEnterpriseAppRequestBody,
  createEnterpriseAppSchema,
  type CreateEnterpriseAppInput,
} from "@/lib/validation/enterprise-apps";
import { OrganizationPicker } from "../../_components/organization-picker";

/** R15: the audience the form proposes for app `id`, under a satellite's default prefix. */
function proposedAudience(id: string): string {
  return `${DEFAULT_SSO_AUDIENCE_PREFIX}:${id}`;
}

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
 *
 * Scope (ADR-0001, R14), as in the new-role form: the form always sends
 * `organization_id`. It used to send none, so every create was a global app,
 * which the route refuses to an org admin: an org admin could not create any
 * app here.
 *   - a SUPERADMIN picks a global app (the default) or any org in the
 *     {@link OrganizationPicker};
 *   - an ORG-CONFINED caller gets no picker and sends `ownOrganization`, the
 *     org the page resolved with the route's own scope rule. App ids are
 *     global names, so the route admits only ids under that org's slug
 *     (I-01): the id is prefilled with `<slug>.`, the field says so, and the
 *     route's 403 for an id outside it lands on the field rather than as a
 *     generic "forbidden". The route also holds such a caller's audience to
 *     one the app's satellite can consume, `<prefix>:<id>` (R15), so the
 *     audience is proposed as `devresponse-app:<id>` and follows the id until
 *     the admin edits it, its hint states the rule, and the route's 400 for
 *     another audience lands on the field.
 */
export function NewEnterpriseAppForm({
  locale,
  showOrgPicker,
  ownOrganization,
}: {
  locale: string;
  showOrgPicker: boolean;
  ownOrganization: { id: string; slug: string } | null;
}) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();
  const slug = ownOrganization?.slug ?? null;

  const form = useZodForm<CreateEnterpriseAppInput>(createEnterpriseAppSchema, {
    defaultValues: {
      id: slug ? `${slug}.` : "",
      label: "",
      description: "",
      origin: "",
      subdomain: "",
      sso_audience: slug ? proposedAudience(`${slug}.`) : "",
      sort_order: 100,
      organization_id: ownOrganization?.id ?? null,
    },
  });

  const onValid = async (values: CreateEnterpriseAppInput) => {
    form.clearErrors("root");
    const payload = createEnterpriseAppRequestBody(values);
    try {
      const res = await fetch("/api/administrator/enterprise-apps", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
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
        } else if (body.error === "audience_taken") {
          form.setError("sso_audience", { type: "server", message: tErr("audienceTaken") });
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
        } else if (
          // R15: the route refuses a confined caller's audience that is not
          // `<prefix>:<id>` with `invalid_body`, so put the rule on the field.
          body.error === "invalid_body" &&
          slug !== null &&
          !isConsumableAudienceFor(payload.sso_audience, payload.id)
        ) {
          form.setError("sso_audience", {
            type: "server",
            message: t("namespace.audienceRefused", { id: payload.id }),
          });
        } else {
          form.setError("root", { type: "server", message: tErr("invalidBody") });
        }
        return;
      }
      if (res.status === 403) {
        // I-01: the route refuses a confined caller an id outside its org's
        // slug with a bare 403, so put the rule on the id field.
        if (slug !== null && !isOrgNamespacedAppId(payload.id, slug)) {
          form.setError("id", { type: "server", message: t("namespace.idRefused", { slug }) });
        } else {
          form.setError("root", { type: "server", message: tErr("forbidden") });
        }
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

        {showOrgPicker ? (
          <FormField
            control={form.control}
            name="organization_id"
            render={({ field }) => (
              // The picker renders its own label and manages a valid value
              // (an org id or null for Global), so it isn't a FormControl child.
              <OrganizationPicker
                id="enterprise-app-organization"
                includeGlobal
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        ) : null}

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
                  onChange={(e) => {
                    const id = e.currentTarget.value.toLowerCase();
                    // R15: the audience follows the id while it is still the
                    // one proposed for the previous id, so until it is edited.
                    if (
                      slug !== null &&
                      form.getValues("sso_audience") === proposedAudience(field.value)
                    ) {
                      form.setValue("sso_audience", proposedAudience(id), {
                        shouldValidate: form.formState.isSubmitted,
                      });
                    }
                    field.onChange(id);
                  }}
                />
              </FormControl>
              <FormDescription>
                {t("fields.idHelp")}
                {slug ? ` ${t("namespace.idHelp", { slug })}` : null}
              </FormDescription>
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
              {slug ? (
                <FormDescription>{t("namespace.audienceHelp", { slug })}</FormDescription>
              ) : null}
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
