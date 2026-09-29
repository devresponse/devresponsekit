import { describe, expectTypeOf, it } from "vitest";
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type {
  AppDatabase,
  AppOrganizationsTable,
  AppRevokedTokensTable,
  AppSsoHandoffNoncesTable,
  AppUsersTable,
} from "@/db/schema/app-schema";

/**
 * F-131: compile-time pins on the Kysely schema's timestamp columns.
 *
 * `Generated<Timestamp>` wrapped one `ColumnType` in another, so 27
 * defaulted timestamp columns (every `created_at` / `updated_at`, and
 * `app_revoked_tokens.revoked_at`) selected as the inner wrapper object
 * instead of `Date`. Every read then needed an `as unknown as Date` cast, and
 * typed `where` / `set` calls refused a plain `Date`, so those went raw or
 * untyped too. A cast compiles whatever the column is, so nothing caught a
 * wrong one.
 *
 * These are TYPE assertions: `pnpm typecheck` (tsc over `tests/**`) is what
 * fails on a regression. At runtime `expectTypeOf` does nothing.
 */

/**
 * True when `T`, or any member of it, is still a Kysely `ColumnType` wrapper,
 * not a value type. Non-distributive, so a wrapper in a union such as
 * `GeneratedTimestamp | null` (the select type of `Generated<GeneratedTimestamp
 * | null>`) is caught too.
 */
type IsColumnTypeWrapper<T> = [Extract<T, { readonly __select__: unknown }>] extends [never]
  ? false
  : true;

/** `table.column` for every column that selects as a wrapper; `never` when none does. */
type WrapperSelections = {
  [TB in keyof AppDatabase]: {
    [C in keyof Selectable<AppDatabase[TB]>]: IsColumnTypeWrapper<
      Selectable<AppDatabase[TB]>[C]
    > extends true
      ? `${TB & string}.${C & string}`
      : never;
  }[keyof Selectable<AppDatabase[TB]>];
}[keyof AppDatabase];

/** True when an insert may leave column `K` out. */
type OptionalOnInsert<T, K extends keyof T> = object extends Pick<T, K> ? true : false;

describe("app schema timestamp typing (F-131)", () => {
  it("counts a wrapper inside a nullable union as a wrapper", () => {
    type NullableNested = Selectable<{
      at: Generated<ColumnType<Date, Date | string | undefined, Date | string> | null>;
    }>["at"];
    expectTypeOf<IsColumnTypeWrapper<NullableNested>>().toEqualTypeOf<true>();
    expectTypeOf<IsColumnTypeWrapper<Date | null>>().toEqualTypeOf<false>();
  });

  it("selects no column of any table as a nested ColumnType wrapper", () => {
    expectTypeOf<WrapperSelections>().toEqualTypeOf<never>();
  });

  it("selects a defaulted timestamp as Date, and lets an insert omit it", () => {
    expectTypeOf<Selectable<AppUsersTable>["created_at"]>().toEqualTypeOf<Date>();
    expectTypeOf<Selectable<AppUsersTable>["updated_at"]>().toEqualTypeOf<Date>();
    expectTypeOf<Selectable<AppRevokedTokensTable>["revoked_at"]>().toEqualTypeOf<Date>();
    expectTypeOf<OptionalOnInsert<Insertable<AppUsersTable>, "created_at">>().toEqualTypeOf<true>();
    expectTypeOf<
      OptionalOnInsert<Insertable<AppRevokedTokensTable>, "revoked_at">
    >().toEqualTypeOf<true>();
  });

  it("takes a Date or an ISO string when a timestamp is written", () => {
    expectTypeOf<Updateable<AppOrganizationsTable>["updated_at"]>().toEqualTypeOf<
      Date | string | undefined
    >();
  });

  it("makes an insert supply a timestamp that has no default", () => {
    expectTypeOf<Selectable<AppSsoHandoffNoncesTable>["expires_at"]>().toEqualTypeOf<Date>();
    expectTypeOf<
      OptionalOnInsert<Insertable<AppSsoHandoffNoncesTable>, "expires_at">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      OptionalOnInsert<Insertable<AppRevokedTokensTable>, "expires_at">
    >().toEqualTypeOf<false>();
    // Nullable with no default: `null` is a value, so an insert may omit it.
    expectTypeOf<
      Selectable<AppSsoHandoffNoncesTable>["consumed_at"]
    >().toEqualTypeOf<Date | null>();
    expectTypeOf<
      OptionalOnInsert<Insertable<AppSsoHandoffNoncesTable>, "consumed_at">
    >().toEqualTypeOf<true>();
  });
});
