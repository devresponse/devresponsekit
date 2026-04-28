/**
 * Tiny database value helpers.
 *
 * Kysely's `ColumnType<Date, ...>` is sometimes inferred as the raw
 * `ColumnType` wrapper at the call site (depending on which selection
 * style was used). At runtime, the `pg` driver always returns
 * `Date` objects for `timestamptz` columns, so this helper lets call
 * sites consume the value as a `Date` without scattering double-casts
 * across the codebase.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  // Defensive fallback: treat unexpected values as the epoch so the UI
  // does not crash. This branch is unreachable in practice given the
  // pg driver's behavior.
  return new Date(0);
}
