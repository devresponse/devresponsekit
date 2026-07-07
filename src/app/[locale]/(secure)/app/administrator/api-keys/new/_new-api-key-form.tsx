"use client";

import { useMemo, useState } from "react";
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
import { ApiKeyRevealDialog } from "@/components/api-keys/api-key-reveal";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { createApiKeySchema, type CreateApiKeyInput } from "@/lib/validation/api-keys";

/**
 * Issue-an-API-key-on-behalf-of-a-user form (docs/admin-manager.md §8.8;
 * docs/form-validation.md). React Hook Form + the shared `createApiKeySchema`
 * (same schema the API route enforces): schema-derived required markers,
 * field-level errors with a red border.
 *
 * Server-only checks map onto the relevant field: a missing/inactive owner
 * (404/409) onto the owner id, and scopes the OWNER does not hold (422,
 * `ungrantableScopes`) onto the scopes group. On success the plaintext is
 * revealed exactly once before returning to the list (no navigation yet).
 */
export function NewApiKeyForm({
  locale,
  scopeCatalog,
}: {
  locale: string;
  scopeCatalog: string[];
}) {
  const t = useTranslations("administrator.apiKeys");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const sortedScopes = useMemo(() => [...scopeCatalog].sort(), [scopeCatalog]);
  const [revealed, setRevealed] = useState<string | null>(null);

  const form = useZodForm<CreateApiKeyInput>(createApiKeySchema, {
    defaultValues: { name: "", ownerAppUserId: "", scopes: [], expiresInDays: undefined },
  });

  const backToList = () => {
    router.push(`/${locale}/app/administrator/api-keys`);
    router.refresh();
  };

  const onValid = async (values: CreateApiKeyInput) => {
    form.clearErrors("root");
    const body: Record<string, unknown> = {
      name: values.name.trim(),
      ownerAppUserId: values.ownerAppUserId.trim(),
      scopes: values.scopes ?? [],
    };
    if (values.expiresInDays != null) body.expiresInDays = values.expiresInDays;

    try {
      const res = await fetch("/api/administrator/api-keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const created = (await res.json()) as { key: string };
        setRevealed(created.key);
        return;
      }
      if (res.status === 404) {
        form.setError("ownerAppUserId", { type: "server", message: t("new.ownerNotFound") });
        return;
      }
      if (res.status === 409) {
        form.setError("ownerAppUserId", { type: "server", message: t("new.ownerInactive") });
        return;
      }
      if (res.status === 422) {
        const data = (await res.json().catch(() => ({}))) as { ungrantableScopes?: string[] };
        form.setError("scopes", {
          type: "server",
          message:
            data.ungrantableScopes && data.ungrantableScopes.length > 0
              ? t("new.invalidScope", { scopes: data.ungrantableScopes.join(", ") })
              : t("new.errorToast"),
        });
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
    <>
      <Form {...form} schema={createApiKeySchema}>
        <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
          <RequiredLegend />

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.name")}</FormLabel>
                <FormControl>
                  <Input type="text" placeholder={t("fields.namePlaceholder")} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="ownerAppUserId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.owner")}</FormLabel>
                <FormControl>
                  <Input
                    type="text"
                    placeholder="00000000-0000-0000-0000-000000000000"
                    {...field}
                  />
                </FormControl>
                <FormDescription>{t("fields.ownerHelp")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="expiresInDays"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.expiresInDays")}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    placeholder={t("fields.expiresInDaysPlaceholder")}
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(
                        e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber,
                      )
                    }
                  />
                </FormControl>
                <FormDescription>{t("fields.expiresInDaysHelp")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="scopes"
            render={({ field }) => {
              const selected = field.value ?? [];
              return (
                <FormItem>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{t("fields.scopes")}</legend>
                    <p className="text-muted-foreground text-xs">{t("fields.scopesHelp")}</p>
                    <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
                      {sortedScopes.map((scope) => (
                        <label key={scope} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={selected.includes(scope)}
                            onCheckedChange={() =>
                              field.onChange(
                                selected.includes(scope)
                                  ? selected.filter((s) => s !== scope)
                                  : [...selected, scope],
                              )
                            }
                          />
                          <code>{scope}</code>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <FormMessage />
                </FormItem>
              );
            }}
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
              onClick={backToList}
            >
              {t("new.cancel")}
            </Button>
          </div>
        </form>
      </Form>
      <ApiKeyRevealDialog
        secret={revealed}
        namespace="administrator.apiKeys.reveal"
        onClose={() => {
          setRevealed(null);
          backToList();
        }}
      />
    </>
  );
}
