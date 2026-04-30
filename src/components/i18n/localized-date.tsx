import { useFormatter, type Formats } from "next-intl";

/**
 * LocalizedDate
 *
 * Server/Client Component that formats a Date or ISO-8601 string using
 * the locale-aware `next-intl` formatter. Renders a `<time>` element so
 * the machine-readable `dateTime` attribute is always present.
 *
 * i18n: uses the request locale resolved by `next-intl`; no prop needed.
 *
 * Accessibility: `<time>` with `dateTime` ensures assistive technologies
 * can interpret the value even if the human-readable format changes.
 */
export function LocalizedDate({
  value,
  format,
}: {
  value: Date | string | number;
  /** A named format key from `next-intl` Formats config, or `undefined` for the default. */
  format?: keyof Formats["dateTime"] | undefined;
}) {
  const formatter = useFormatter();
  const date = value instanceof Date ? value : new Date(value);
  const formatted = formatter.dateTime(date, format);

  return <time dateTime={date.toISOString()}>{formatted}</time>;
}
