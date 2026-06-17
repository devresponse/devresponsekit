"use client";

import { useMemo, useState } from "react";
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
import { RequiredLegend } from "@/components/ui/required-legend";
import { DATE_FORMAT_OPTIONS } from "@/lib/account/preferences";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { updatePreferencesSchema, type UpdatePreferencesInput } from "@/lib/validation/account";

/**
 * Preferences editor (self-service; docs/form-validation.md). React Hook Form +
 * the shared `updatePreferencesSchema` (the same schema `/api/account/preferences`
 * enforces) — locale/date/number are constrained choices; time zone is optional.
 */
export interface PreferencesFormProps {
  locales: string[];
  initial: {
    preferredLocale: string;
    timeZone: string;
    dateFormat: string;
    numberFormatLocale: string;
  };
}

const SELECT_CLASS =
  "border-input bg-background aria-invalid:border-destructive h-9 w-full rounded-md border px-2 text-sm";

function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function PreferencesForm({ locales, initial }: PreferencesFormProps) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const timeZones = useMemo(() => listTimeZones(), []);
  const [saved, setSaved] = useState(false);
  const form = useZodForm<UpdatePreferencesInput>(updatePreferencesSchema, {
    defaultValues: {
      preferredLocale: initial.preferredLocale,
      timeZone: initial.timeZone,
      dateFormat: initial.dateFormat,
      numberFormatLocale: initial.numberFormatLocale,
    },
  });

  const onValid = async (values: UpdatePreferencesInput) => {
    form.clearErrors("root");
    setSaved(false);
    try {
      const res = await fetch("/api/account/preferences", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preferredLocale: values.preferredLocale,
          timeZone: values.timeZone || null,
          dateFormat: values.dateFormat,
          numberFormatLocale: values.numberFormatLocale,
        }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      form.setError("root", {
        type: "server",
        message: res.status === 400 ? t("errors.invalid") : t("errors.saveFailed"),
      });
    } catch {
      form.setError("root", { type: "server", message: t("errors.saveFailed") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={updatePreferencesSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        <FormField
          control={form.control}
          name="preferredLocale"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.locale")}</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  {locales.map((loc) => (
                    <option key={loc} value={loc}>
                      {t(`locales.${loc}` as Parameters<typeof t>[0])}
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
          name="timeZone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.timeZone")}</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field} value={field.value ?? ""}>
                  <option value="">{t("fields.system")}</option>
                  {timeZones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
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
          name="dateFormat"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.dateFormat")}</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  {DATE_FORMAT_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {t(`dateFormats.${opt}` as Parameters<typeof t>[0])}
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
          name="numberFormatLocale"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.numberFormatLocale")}</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="system">{t("fields.system")}</option>
                  {locales.map((loc) => (
                    <option key={loc} value={loc}>
                      {t(`locales.${loc}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </select>
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
          <p className="text-muted-foreground text-sm" role="status">
            {t("saved")}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={form.formState.isSubmitting}
            onClick={() => router.refresh()}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
