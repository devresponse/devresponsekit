"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DATE_FORMAT_OPTIONS } from "@/lib/account/preferences";

/**
 * Preferences editor (self-service): locale, time zone, date format, and
 * number-format locale. Controlled selects whose allowed values mirror
 * the server Zod schema in `/api/account/preferences` (the source of
 * truth). Self-scoped endpoint — no identifier is sent.
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

const SELECT_CLASS = "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

function listTimeZones(): string[] {
  // `Intl.supportedValuesOf` is available in modern engines; fall back to
  // a small common set so the control still works if it is absent.
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

  const [preferredLocale, setPreferredLocale] = useState(initial.preferredLocale);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [dateFormat, setDateFormat] = useState(initial.dateFormat);
  const [numberFormatLocale, setNumberFormatLocale] = useState(initial.numberFormatLocale);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saved">("idle");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setStatus("idle");
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/preferences", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preferredLocale,
          timeZone: timeZone || null,
          dateFormat,
          numberFormatLocale,
        }),
      });
      if (res.ok) {
        setStatus("saved");
        router.refresh();
        return;
      }
      setError(res.status === 400 ? t("errors.invalid") : t("errors.saveFailed"));
    } catch {
      setError(t("errors.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="pref-locale">{t("fields.locale")}</Label>
        <select
          id="pref-locale"
          className={SELECT_CLASS}
          value={preferredLocale}
          onChange={(e) => setPreferredLocale(e.currentTarget.value)}
        >
          {locales.map((loc) => (
            <option key={loc} value={loc}>
              {t(`locales.${loc}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pref-timezone">{t("fields.timeZone")}</Label>
        <select
          id="pref-timezone"
          className={SELECT_CLASS}
          value={timeZone}
          onChange={(e) => setTimeZone(e.currentTarget.value)}
        >
          <option value="">{t("fields.system")}</option>
          {timeZones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pref-date-format">{t("fields.dateFormat")}</Label>
        <select
          id="pref-date-format"
          className={SELECT_CLASS}
          value={dateFormat}
          onChange={(e) => setDateFormat(e.currentTarget.value)}
        >
          {DATE_FORMAT_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {t(`dateFormats.${opt}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pref-number-locale">{t("fields.numberFormatLocale")}</Label>
        <select
          id="pref-number-locale"
          className={SELECT_CLASS}
          value={numberFormatLocale}
          onChange={(e) => setNumberFormatLocale(e.currentTarget.value)}
        >
          <option value="system">{t("fields.system")}</option>
          {locales.map((loc) => (
            <option key={loc} value={loc}>
              {t(`locales.${loc}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {status === "saved" ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("saved")}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.refresh()}
        >
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
