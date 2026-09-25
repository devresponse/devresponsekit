/**
 * The one date/number formatter behind every timestamp, date and number the
 * UI displays (F-37).
 *
 * Before F-37 each page and grid built its own `new Intl.DateTimeFormat(locale,
 * …)`. That had two faults. The account preferences (time zone, date format,
 * number format) were saved and then read by nothing. And a formatter that
 * names no zone uses the zone of whatever runtime it runs in, so a
 * server-rendered time (the server's zone, UTC on Vercel) and a
 * client-rendered one (the browser's zone) disagreed for the same row: an
 * admin in Vancouver saw a registration at 3:04 PM on the Administrator
 * overview and 8:04 AM in the Users grid.
 *
 * This module is pure (no React, no `server-only`), so the server
 * (`getAppFormatter`, `src/lib/format/viewer-format.server.ts`) and the client
 * (`useAppFormatter`, `src/components/i18n/format-preferences.tsx`) run the
 * SAME code over the SAME inputs and produce the same text. The inputs are the
 * UI locale plus {@link FormatPreferences}, resolved once per request on the
 * server. The zone reaches the client through next-intl's own `timeZone`
 * config, so next-intl and this formatter cannot disagree about it.
 *
 * Why not next-intl's `useFormatter` alone: its named `formats` are Intl
 * options applied in the UI locale, and Intl options cannot choose field
 * ORDER. "US (06/13/2026)", "European (13/06/2026)" and "ISO 8601
 * (2026-06-13)" read the same in every UI language, and a number format
 * locale differs from the UI locale by definition. So the numeric patterns are
 * assembled from `formatToParts`, and numbers use their own locale.
 * `tests/unit/intl-formatter-invariant.test.ts` fails on a new ad-hoc Intl
 * formatter, or a direct next-intl formatter, under `src/app` and
 * `src/components`.
 */
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import {
  isDateFormatOption,
  isValidTimeZone,
  type DateFormatOption,
} from "@/lib/account/preferences";

/** How the viewer wants dates and numbers shown, fully resolved (no NULLs to interpret). */
export interface FormatPreferences {
  /** IANA zone every instant is shown in: the saved zone, else the deployment's. */
  timeZone: string;
  /** `"system"` = the UI locale's own style. */
  dateFormat: DateFormatOption;
  /** Locale numbers are grouped/punctuated in; `null` = the UI locale. */
  numberLocale: SupportedLocale | null;
}

/** The `app_user_locale_preferences` columns, as stored (NULL = "system"). */
export interface StoredFormatPreferences {
  time_zone: string | null;
  date_format: string | null;
  number_format_locale: string | null;
}

/**
 * Maps a stored preferences row to {@link FormatPreferences}.
 *
 * A NULL column, or no row at all, is "system". A value this runtime cannot use
 * is treated as "system" too rather than thrown on: a zone the server's ICU
 * does not know (a row saved under a newer tzdata, or written by hand), a
 * date-format key or a number locale outside today's allow-lists. The page
 * must render whatever the row holds.
 */
export function resolveFormatPreferences(
  stored: StoredFormatPreferences | null | undefined,
  defaultTimeZone: string,
): FormatPreferences {
  const timeZone = stored?.time_zone;
  const dateFormat = stored?.date_format;
  const numberLocale = stored?.number_format_locale;
  return {
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : defaultTimeZone,
    dateFormat: isDateFormatOption(dateFormat) ? dateFormat : "system",
    numberLocale: isSupportedLocale(numberLocale) ? numberLocale : null,
  };
}

/** Preferences for a viewer with none saved: the UI locale's style in `timeZone`. */
export function systemFormatPreferences(timeZone: string): FormatPreferences {
  return { timeZone, dateFormat: "system", numberLocale: null };
}

/** An instant (Date, epoch ms or ISO string) or a calendar date (`YYYY-MM-DD`). */
export type DateInput = Date | string | number;

export interface DateOptions {
  /**
   * The shape used when the viewer's date format is "system" (default
   * `medium`, e.g. "Jun 13, 2026"). `monthDay` is a short axis label ("Jun
   * 13"). A chosen format (ISO, US, European, Long) overrides the style.
   */
  style?: "medium" | "long" | "monthDay";
}

export interface DateTimeOptions {
  /** Include seconds (audit trails, delivery logs). */
  seconds?: boolean;
}

export interface AppFormatter {
  /** A date without its time. */
  date(value: DateInput, options?: DateOptions): string;
  /** A date with its time. */
  dateTime(value: DateInput, options?: DateTimeOptions): string;
  /** A number, in the viewer's number-format locale. */
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
}

/**
 * A bare `YYYY-MM-DD` is a calendar DATE, not an instant (the Administrator
 * overview's day buckets, for example, which are already days in the viewer's
 * zone). `new Date("2026-06-13")` is UTC midnight, so formatting it in the
 * viewer's zone would show June 12 everywhere west of Greenwich. A calendar
 * date is therefore always formatted in UTC: it shows the day it names in
 * every zone.
 */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** en-US digits and parts are stable across ICU builds; used only for the numeric patterns. */
const PARTS_LOCALE = "en-US";

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

export function createAppFormatter(locale: string, prefs: FormatPreferences): AppFormatter {
  const { dateFormat } = prefs;
  const numberLocale = prefs.numberLocale ?? locale;

  // Intl construction is the expensive part, so one formatter object caches
  // its instances (the grids build one per render and format every row).
  const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
  const numberFormats = new Map<string, Intl.NumberFormat>();

  function dtf(forLocale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${forLocale}|${JSON.stringify(options)}`;
    let format = dateTimeFormats.get(key);
    if (!format) {
      try {
        format = new Intl.DateTimeFormat(forLocale, options);
      } catch {
        // A zone the SERVER validated can still be unknown to an older
        // browser's tzdata, and Intl throws a RangeError for it. Showing UTC
        // there beats crashing the whole grid over one cell.
        format = new Intl.DateTimeFormat(forLocale, { ...options, timeZone: "UTC" });
      }
      dateTimeFormats.set(key, format);
    }
    return format;
  }

  function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = JSON.stringify(options);
    let format = numberFormats.get(key);
    if (!format) {
      format = new Intl.NumberFormat(numberLocale, options);
      numberFormats.set(key, format);
    }
    return format;
  }

  /** The instant to format and the zone to format it in, or null when unparseable. */
  function resolve(value: DateInput): { date: Date; timeZone: string } | null {
    if (typeof value === "string" && CALENDAR_DATE.test(value)) {
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? null : { date, timeZone: "UTC" };
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : { date, timeZone: prefs.timeZone };
  }

  function parts(date: Date, options: Intl.DateTimeFormatOptions): Parts {
    const out: Parts = {};
    for (const part of dtf(PARTS_LOCALE, options).formatToParts(date)) out[part.type] = part.value;
    return out;
  }

  /** Year, month and day as fixed-width digits in `timeZone`. */
  function ymd(date: Date, timeZone: string) {
    const p = parts(date, { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
    return { y: (p.year ?? "").padStart(4, "0"), m: p.month ?? "", d: p.day ?? "" };
  }

  function numericDate(date: Date, timeZone: string, monthDayOnly: boolean): string {
    const { y, m, d } = ymd(date, timeZone);
    switch (dateFormat) {
      case "iso8601":
        return monthDayOnly ? `${m}-${d}` : `${y}-${m}-${d}`;
      case "us":
        return monthDayOnly ? `${m}/${d}` : `${m}/${d}/${y}`;
      default: // "eu"
        return monthDayOnly ? `${d}/${m}` : `${d}/${m}/${y}`;
    }
  }

  const isNumeric = dateFormat === "iso8601" || dateFormat === "us" || dateFormat === "eu";

  return {
    date(value, options = {}) {
      const resolved = resolve(value);
      if (!resolved) return String(value);
      const { date, timeZone } = resolved;
      const style = options.style ?? "medium";
      if (isNumeric) return numericDate(date, timeZone, style === "monthDay");
      if (style === "monthDay") {
        const month = dateFormat === "long" ? "long" : "short";
        return dtf(locale, { month, day: "numeric", timeZone }).format(date);
      }
      const dateStyle = dateFormat === "long" ? "long" : style;
      return dtf(locale, { dateStyle, timeZone }).format(date);
    },

    dateTime(value, options = {}) {
      const resolved = resolve(value);
      if (!resolved) return String(value);
      const { date, timeZone } = resolved;
      const timeStyle = options.seconds ? "medium" : "short";
      if (dateFormat === "iso8601") {
        // ISO 8601 reads as one 24-hour stamp: "2026-06-13 15:04".
        const p = parts(date, {
          hour: "2-digit",
          minute: "2-digit",
          ...(options.seconds ? { second: "2-digit" as const } : {}),
          hourCycle: "h23",
          timeZone,
        });
        const time = `${p.hour}:${p.minute}${options.seconds ? `:${p.second}` : ""}`;
        return `${numericDate(date, timeZone, false)} ${time}`;
      }
      if (isNumeric) {
        // US / European fix the DATE's field order; the time stays in the UI
        // language's own convention (12- or 24-hour, its day-period words).
        return `${numericDate(date, timeZone, false)} ${dtf(locale, { timeStyle, timeZone }).format(date)}`;
      }
      const dateStyle = dateFormat === "long" ? "long" : "medium";
      return dtf(locale, { dateStyle, timeStyle, timeZone }).format(date);
    },

    number(value, options = {}) {
      return nf(options).format(value);
    },
  };
}
