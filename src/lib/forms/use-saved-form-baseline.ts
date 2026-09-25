"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { DefaultValues, FieldValues, UseFormProps, UseFormReturn } from "react-hook-form";
import type { ZodType } from "zod";
import { useZodForm } from "./use-zod-form";

/**
 * F-39: the ONE save pattern for a settings form seeded from server (RSC)
 * props: the organization, role and group Settings tabs and the organization
 * Authentication tab (docs/form-validation.md).
 *
 * Radix Tabs unmount an inactive panel, so every tab switch remounts the form
 * from the props the page was rendered with, and nothing moved those props
 * after a save. A superadmin suspended an org, looked at Members, came back to
 * Settings and saw Active again; they fixed a typo in the name and saved, and
 * the PATCH, which re-sent every field, silently un-suspended the org (with an
 * audit row recording a status change). Three rules close that here:
 *
 *   1. `commitSaved` runs after a successful save. It moves React Hook Form's
 *      baseline to what was saved and calls `router.refresh()`, so the RSC
 *      re-renders and the props (the page header too) become the saved state.
 *      A remount after that seeds from it. It moves the baseline ONLY: every
 *      field keeps what it shows (`keepValues`). The inputs stay live while
 *      the request is in flight, and `saved` is the submit-time snapshot, so
 *      resetting the values to it erased anything typed meanwhile and the
 *      next Save found nothing to send. A field that matches the save is
 *      clean at once; one typed into since is dirty and goes in the next save.
 *   2. The form FOLLOWS `serverValues`. When they change (the refresh landing,
 *      possibly after a remount that happened while it was in flight) the
 *      baseline moves to them and every field the admin has not edited takes
 *      the new value (`keepDirtyValues`); an edit in progress is kept, and so
 *      are the errors, touched fields and submit state, so a failed save's
 *      message outlives an earlier save's refresh landing. Rule 1 recomputes
 *      the dirty fields against the saved baseline, so a field that save wrote
 *      is not an "edit" here: it takes the refreshed value.
 *   3. `changedBody` builds the PATCH body from ONLY the fields that differ
 *      from that baseline, compared after the form's own normalization
 *      (`toBody`), so a whitespace-only edit is not a change. An untouched
 *      field is never re-written, even from a view that is momentarily stale,
 *      and the route's audit row names only the fields the admin changed (the
 *      group route's `fields` also carries its `updated_at` stamp). Use it
 *      only against a route whose PATCH contract is partial; one that replaces
 *      a complete record (the sign-up policy) sends `toBody(values)` whole and
 *      relies on rules 1 and 2.
 *
 * Not solved here: two admins, or two browser tabs, editing the same record.
 * Rule 3 limits the stale side to the fields it changed, but nothing detects
 * the conflict; that needs ETag / If-Match on the PATCH routes (the known
 * limitation in docs/admin-manager.md §8).
 *
 * `serverValues` must be JSON-plain (strings, numbers, booleans, null, arrays):
 * it is compared by its JSON text so a fresh object literal on every render is
 * not a change.
 */
export function useSavedFormBaseline<
  TValues extends FieldValues,
  TBody extends Record<string, unknown>,
>(
  schema: ZodType,
  serverValues: TValues,
  toBody: (values: TValues) => TBody,
  options?: Omit<UseFormProps<TValues>, "resolver" | "defaultValues" | "values">,
): {
  form: UseFormReturn<TValues>;
  changedBody(values: TValues): Partial<TBody> | null;
  commitSaved(saved: TValues): void;
} {
  const router = useRouter();
  const form = useZodForm<TValues>(schema, {
    ...options,
    defaultValues: serverValues as DefaultValues<TValues>,
  });

  // Rule 2. Keyed on the JSON text, and skipping the mount (the form was just
  // created from these values), so only a real change of the server's answer
  // moves the baseline.
  const serverKey = JSON.stringify(serverValues);
  const appliedKey = useRef(serverKey);
  useEffect(() => {
    if (appliedKey.current === serverKey) return;
    appliedKey.current = serverKey;
    form.reset(JSON.parse(serverKey) as TValues, {
      keepDirtyValues: true,
      keepErrors: true,
      keepTouched: true,
      keepIsSubmitted: true,
      keepSubmitCount: true,
    });
  }, [form, serverKey]);

  return {
    form,
    changedBody(values) {
      // RHF's baseline: the server values, moved by rule 1 and rule 2.
      const baseline = form.formState.defaultValues as TValues;
      const changed = pickChangedFields(toBody(values), toBody(baseline));
      return Object.keys(changed).length > 0 ? changed : null;
    },
    commitSaved(saved) {
      // Rule 1: the baseline becomes `saved`; the values stay as they are now
      // (an edit typed while the request was in flight survives), and the
      // dirty fields are recomputed against the new baseline.
      form.reset(saved, { keepValues: true });
      router.refresh();
    },
  };
}

/**
 * The entries of `next` whose value differs from the same key in `baseline`
 * (by JSON value, so arrays compare by content). Pure; exported for tests.
 */
export function pickChangedFields<T extends Record<string, unknown>>(
  next: T,
  baseline: T,
): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(baseline[key])) {
      changed[key] = next[key];
    }
  }
  return changed;
}
