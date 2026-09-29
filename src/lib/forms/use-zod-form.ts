"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  useForm,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import type { ZodType } from "zod";

/**
 * Shared React Hook Form + Zod setup for every app form (docs/form-validation.md).
 *
 * Pass the form's value type explicitly and the matching Zod schema — the same
 * schema the API route uses, so client and server can't drift:
 *   `const form = useZodForm<CreateUserInput>(createUserSchema, { defaultValues })`
 *
 * UX defaults follow best practice:
 *   - `mode: "onTouched"` — validate a field once it's been blurred, not while
 *     the user is first typing into it.
 *   - `reValidateMode: "onChange"` — once a field has shown an error, correct
 *     it live as they fix it.
 *   - `shouldFocusError: true` — move focus to the first invalid field on a
 *     failed submit (keyboard/screen-reader accessibility).
 * Any option can be overridden via `options`.
 */
export function useZodForm<TValues extends FieldValues>(
  schema: ZodType,
  options?: Omit<UseFormProps<TValues>, "resolver">,
): UseFormReturn<TValues> {
  return useForm<TValues>({
    mode: "onTouched",
    reValidateMode: "onChange",
    shouldFocusError: true,
    ...options,
    // The schema/value-type pairing is the caller's contract; the resolver is
    // structurally erased here, so a double assertion is the cleanest bridge.
    resolver: zodResolver(schema as never) as unknown as Resolver<TValues>,
  });
}
