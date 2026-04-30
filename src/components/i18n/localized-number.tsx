import { useFormatter } from "next-intl";

/**
 * LocalizedNumber
 *
 * Server/Client Component that formats a number using the locale-aware
 * `next-intl` formatter. Renders as a `<span>` with the raw numeric value
 * in a `data-value` attribute for programmatic access.
 *
 * i18n: uses the request locale resolved by `next-intl`.
 *
 * Example: `<LocalizedNumber value={1234567.89} options={{ style: "currency", currency: "USD" }} />`
 */
export function LocalizedNumber({
  value,
  options,
}: {
  value: number;
  options?: Parameters<ReturnType<typeof useFormatter>["number"]>[1];
}) {
  const format = useFormatter();
  const formatted = format.number(value, options);

  return <span data-value={value}>{formatted}</span>;
}
