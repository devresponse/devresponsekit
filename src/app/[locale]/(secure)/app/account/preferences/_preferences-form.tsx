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
import { useHydrated } from "@/hooks/use-hydrated";
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

/**
 * The runtime's IANA zone list. Consumed CLIENT-ONLY on purpose (review
 * #108): `Intl.supportedValuesOf("timeZone")` is answered from the host's
 * own ICU build, and the Node server and the user's browser routinely ship
 * different tzdata revisions. Rendering it on both sides produced option
 * lists of different lengths under identical markup — a hydration mismatch
 * that makes React discard the server-rendered `<select>`.
 */
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

  const hydrated = useHydrated();
  /**
   * Deterministic option list (review #108). Before hydration the only
   * option beyond "system" is the STORED zone, which arrived from the
   * server as a prop — so the server markup and the first client render
   * are identical whatever ICU data each side carries. The full list is
   * added by the post-hydration render. Because the stored value is always
   * an option, a zone the runtime no longer enumerates (a renamed alias
   * such as `Asia/Calcutta`) still renders as itself instead of silently
   * collapsing to "System".
   */
  const timeZones = useMemo(() => {
    const list = hydrated ? listTimeZones() : [];
    const stored = initial.timeZone;
    return stored && !list.includes(stored) ? [stored, ...list] : list;
  }, [hydrated, initial.timeZone]);

  const [saved, setSaved] = useState(false);
  // One object for both the initial values and the Cancel reset so the two
  // can never drift (review #103).
  const initialValues = useMemo<UpdatePreferencesInput>(
    () => ({
      preferredLocale: initial.preferredLocale,
      timeZone: initial.timeZone,
      dateFormat: initial.dateFormat,
      numberFormatLocale: initial.numberFormatLocale,
    }),
    [initial.preferredLocale, initial.timeZone, initial.dateFormat, initial.numberFormatLocale],
  );
  const form = useZodForm<UpdatePreferencesInput>(updatePreferencesSchema, {
    defaultValues: initialValues,
  });

  /**
   * Cancel discards the edits. `router.refresh()` ALONE was a no-op
   * (review #103): it re-renders the server tree, but React Hook Form keeps
   * its own client state, so the typed-in values, the validation errors and
   * the sticky "saved" notice all survived. Reset to the server-supplied
   * values explicitly, then refresh so a concurrent update still lands.
   */
  const onCancel = () => {
    form.reset(initialValues);
    form.clearErrors();
    setSaved(false);
    router.refresh();
  };

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
            onClick={onCancel}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
