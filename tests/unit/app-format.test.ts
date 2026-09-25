import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createAppFormatter,
  resolveFormatPreferences,
  systemFormatPreferences,
  type FormatPreferences,
} from "@/lib/format/app-format";

/**
 * F-37: the one formatter behind every date, time and number in the UI.
 *
 * Expected strings for the locale-styled cases are computed with Intl here
 * (never hand-typed), so the assertions hold on any ICU build. The numeric
 * patterns (ISO, US, European) are assembled from parts and are asserted
 * literally: they must read the same everywhere.
 */

// 22:04:05 UTC on 13 June 2026: 01:04 on the 14th in Kyiv (UTC+3), 15:04 on
// the 13th in Vancouver (UTC-7), 03:49 on the 14th in Kathmandu (UTC+5:45).
const INSTANT = "2026-06-13T22:04:05.000Z";
const at = (d = INSTANT) => new Date(d);

const prefs = (over: Partial<FormatPreferences> = {}): FormatPreferences => ({
  ...systemFormatPreferences("UTC"),
  ...over,
});

const intl = (locale: string, options: Intl.DateTimeFormatOptions, value = at()) =>
  new Intl.DateTimeFormat(locale, options).format(value);

describe("resolveFormatPreferences", () => {
  it("no row, or all-NULL columns, is the system style in the default zone", () => {
    const expected = { timeZone: "America/Vancouver", dateFormat: "system", numberLocale: null };
    expect(resolveFormatPreferences(undefined, "America/Vancouver")).toEqual(expected);
    expect(resolveFormatPreferences(null, "America/Vancouver")).toEqual(expected);
    expect(
      resolveFormatPreferences(
        { time_zone: null, date_format: null, number_format_locale: null },
        "America/Vancouver",
      ),
    ).toEqual(expected);
  });

  it("maps a saved row", () => {
    expect(
      resolveFormatPreferences(
        { time_zone: "Europe/Kyiv", date_format: "iso8601", number_format_locale: "fr" },
        "UTC",
      ),
    ).toEqual({ timeZone: "Europe/Kyiv", dateFormat: "iso8601", numberLocale: "fr" });
  });

  it("treats a value this runtime cannot use as system instead of throwing", () => {
    expect(
      resolveFormatPreferences(
        { time_zone: "Mars/Olympus_Mons", date_format: "klingon", number_format_locale: "xx" },
        "UTC",
      ),
    ).toEqual({ timeZone: "UTC", dateFormat: "system", numberLocale: null });
  });
});

describe("createAppFormatter — the time zone", () => {
  it("formats one instant in the viewer's zone, not the host's", () => {
    const kyiv = createAppFormatter("en", prefs({ timeZone: "Europe/Kyiv" }));
    const vancouver = createAppFormatter("en", prefs({ timeZone: "America/Vancouver" }));
    expect(kyiv.dateTime(INSTANT)).toBe(
      intl("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Kyiv" }),
    );
    expect(vancouver.dateTime(INSTANT)).toBe(
      intl("en", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Vancouver" }),
    );
    // The F-37 scenario: the same row read differently depending on where it
    // was rendered. With the zone fixed, only the chosen zone moves it.
    expect(kyiv.dateTime(INSTANT)).not.toBe(vancouver.dateTime(INSTANT));
    expect(kyiv.date(INSTANT)).toBe(intl("en", { dateStyle: "medium", timeZone: "Europe/Kyiv" }));
  });

  it("accepts a Date, an epoch and an ISO string alike", () => {
    const format = createAppFormatter("en", prefs({ timeZone: "Asia/Kathmandu" }));
    const expected = format.dateTime(INSTANT);
    expect(format.dateTime(at())).toBe(expected);
    expect(format.dateTime(at().getTime())).toBe(expected);
  });

  it("shows a bare calendar date as the day it names in every zone", () => {
    for (const timeZone of ["Pacific/Pago_Pago", "UTC", "Pacific/Kiritimati"]) {
      const format = createAppFormatter("en", prefs({ timeZone, dateFormat: "iso8601" }));
      expect(format.date("2026-06-13")).toBe("2026-06-13");
      expect(
        createAppFormatter("en", prefs({ timeZone })).date("2026-06-13", {
          style: "monthDay",
        }),
      ).toBe(intl("en", { month: "short", day: "numeric", timeZone: "UTC" }, at("2026-06-13")));
    }
  });

  it("falls back to UTC for a zone this runtime does not know, instead of throwing", () => {
    const format = createAppFormatter("en", prefs({ timeZone: "Mars/Olympus_Mons" }));
    expect(format.dateTime(INSTANT)).toBe(
      intl("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("returns an unparseable value as given, never 'Invalid Date'", () => {
    const format = createAppFormatter("en", prefs());
    expect(format.date("not-a-date")).toBe("not-a-date");
    expect(format.dateTime("2026-13-45T99:00:00Z")).toBe("2026-13-45T99:00:00Z");
  });
});

describe("createAppFormatter — the date format", () => {
  const kyiv = (dateFormat: FormatPreferences["dateFormat"], locale = "en") =>
    createAppFormatter(locale, prefs({ timeZone: "Europe/Kyiv", dateFormat }));

  it("system follows the UI locale's own styles", () => {
    expect(kyiv("system", "uk").date(INSTANT)).toBe(
      intl("uk", { dateStyle: "medium", timeZone: "Europe/Kyiv" }),
    );
    expect(kyiv("system").date(INSTANT, { style: "long" })).toBe(
      intl("en", { dateStyle: "long", timeZone: "Europe/Kyiv" }),
    );
    expect(kyiv("system").dateTime(INSTANT, { seconds: true })).toBe(
      intl("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "Europe/Kyiv" }),
    );
  });

  it("ISO 8601 is year-month-day with a 24-hour time, in any UI language", () => {
    for (const locale of ["en", "uk", "ja"]) {
      expect(kyiv("iso8601", locale).date(INSTANT)).toBe("2026-06-14");
      expect(kyiv("iso8601", locale).dateTime(INSTANT)).toBe("2026-06-14 01:04");
      expect(kyiv("iso8601", locale).dateTime(INSTANT, { seconds: true })).toBe(
        "2026-06-14 01:04:05",
      );
      expect(kyiv("iso8601", locale).date(INSTANT, { style: "monthDay" })).toBe("06-14");
    }
    // Midnight is 00, never 24.
    expect(kyiv("iso8601").dateTime("2026-06-13T21:00:00Z")).toBe("2026-06-14 00:00");
  });

  it("US and European fix the date's field order; the time follows the UI language", () => {
    const time = intl("en", { timeStyle: "short", timeZone: "Europe/Kyiv" });
    expect(kyiv("us").date(INSTANT)).toBe("06/14/2026");
    expect(kyiv("us").dateTime(INSTANT)).toBe(`06/14/2026 ${time}`);
    expect(kyiv("us").date(INSTANT, { style: "monthDay" })).toBe("06/14");
    expect(kyiv("eu").date(INSTANT)).toBe("14/06/2026");
    expect(kyiv("eu").dateTime(INSTANT)).toBe(`14/06/2026 ${time}`);
    expect(kyiv("eu").date(INSTANT, { style: "monthDay" })).toBe("14/06");
    expect(kyiv("eu", "uk").dateTime(INSTANT)).toBe(
      `14/06/2026 ${intl("uk", { timeStyle: "short", timeZone: "Europe/Kyiv" })}`,
    );
  });

  it("Long spells the month out whatever style the call site asked for", () => {
    expect(kyiv("long").date(INSTANT)).toBe(
      intl("en", { dateStyle: "long", timeZone: "Europe/Kyiv" }),
    );
    expect(kyiv("long").dateTime(INSTANT)).toBe(
      intl("en", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Kyiv" }),
    );
    expect(kyiv("long").date(INSTANT, { style: "monthDay" })).toBe(
      intl("en", { month: "long", day: "numeric", timeZone: "Europe/Kyiv" }),
    );
  });

  it("the numeric patterns are one date in three orders (property)", () => {
    const zones = ["UTC", "Europe/Kyiv", "America/Vancouver", "Asia/Kathmandu", "Pacific/Chatham"];
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2100, 0, 1) }),
        fc.constantFrom(...zones),
        (epoch, timeZone) => {
          const iso = createAppFormatter("en", prefs({ timeZone, dateFormat: "iso8601" }));
          const [date, time] = iso.dateTime(epoch).split(" ");
          const [y, m, d] = date!.split("-");
          expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
          expect(iso.date(epoch)).toBe(date);
          expect(createAppFormatter("fr", prefs({ timeZone, dateFormat: "us" })).date(epoch)).toBe(
            `${m}/${d}/${y}`,
          );
          expect(createAppFormatter("ja", prefs({ timeZone, dateFormat: "eu" })).date(epoch)).toBe(
            `${d}/${m}/${y}`,
          );
        },
      ),
    );
  });
});

describe("createAppFormatter — numbers", () => {
  it("uses the UI locale by default", () => {
    expect(createAppFormatter("en", prefs()).number(12345.5)).toBe("12,345.5");
  });

  it("uses the saved number-format locale over the UI locale", () => {
    const format = createAppFormatter("en", prefs({ numberLocale: "fr" }));
    expect(format.number(12345.5)).toBe(new Intl.NumberFormat("fr").format(12345.5));
    expect(format.number(12345.5)).not.toBe("12,345.5");
    expect(format.number(0.25, { style: "percent" })).toBe(
      new Intl.NumberFormat("fr", { style: "percent" }).format(0.25),
    );
  });
});
