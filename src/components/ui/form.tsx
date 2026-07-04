"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  type FormProviderProps,
} from "react-hook-form";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Carries the form's Zod schema so `FormLabel` can derive which fields are
 * required (rendering an asterisk) and `FormControl` can set `aria-required`,
 * without a manual per-field flag. Optional — a form that passes no schema
 * simply gets no auto-derived required markers (use the explicit `required`
 * prop on `FormLabel` instead, e.g. for `.refine()`-wrapped schemas).
 */
const FormSchemaContext = React.createContext<unknown>(null);

/** True when the schema's top-level field rejects `undefined` (i.e. required). */
function isFieldRequired(schema: unknown, name: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const top = name.split(".")[0];
  if (!top) return false;
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  const field = shape?.[top] as
    { safeParse?: (value: unknown) => { success: boolean } } | undefined;
  if (!field || typeof field.safeParse !== "function") return false;
  return !field.safeParse(undefined).success;
}

function Form<
  TFieldValues extends FieldValues = FieldValues,
  TContext = unknown,
  TTransformedValues extends FieldValues = TFieldValues,
>({
  schema,
  ...props
}: FormProviderProps<TFieldValues, TContext, TTransformedValues> & { schema?: unknown }) {
  return (
    <FormSchemaContext.Provider value={schema ?? null}>
      <FormProvider {...props} />
    </FormSchemaContext.Provider>
  );
}

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
};

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const schema = React.useContext(FormSchemaContext);
  const { getFieldState, formState } = useFormContext();

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>");
  }

  if (!itemContext) {
    throw new Error("useFormField should be used within <FormItem>");
  }

  const fieldState = getFieldState(fieldContext.name, formState);

  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    isRequired: isFieldRequired(schema, fieldContext.name),
    ...fieldState,
  };
};

type FormItemContextValue = {
  id: string;
};

const FormItemContext = React.createContext<FormItemContextValue | null>(null);

const FormItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const id = React.useId();

    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={ref} className={cn("space-y-2", className)} {...props} />
      </FormItemContext.Provider>
    );
  },
);
FormItem.displayName = "FormItem";

const FormLabel = React.forwardRef<
  React.ElementRef<typeof Label>,
  React.ComponentPropsWithoutRef<typeof Label> & {
    /** Force the required `*` on/off; defaults to the schema-derived value. */
    required?: boolean;
  }
>(({ className, required, children, ...props }, ref) => {
  const { error, formItemId, isRequired } = useFormField();
  const showRequired = required ?? isRequired;

  return (
    <Label
      ref={ref}
      className={cn(error && "text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    >
      {children}
      {showRequired ? (
        // Decorative — requiredness is conveyed to assistive tech via the
        // control's `aria-required` (set by FormControl). A page-level
        // RequiredLegend explains the marker.
        <span aria-hidden="true" className="text-destructive ml-0.5">
          *
        </span>
      ) : null}
    </Label>
  );
});
FormLabel.displayName = "FormLabel";

const FormControl = React.forwardRef<
  React.ElementRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId, isRequired } = useFormField();

  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={!error ? `${formDescriptionId}` : `${formDescriptionId} ${formMessageId}`}
      aria-invalid={!!error}
      aria-required={isRequired || undefined}
      {...props}
    />
  );
});
FormControl.displayName = "FormControl";

const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();

  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn("text-muted-foreground text-[0.8rem]", className)}
      {...props}
    />
  );
});
FormDescription.displayName = "FormDescription";

const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField();
  const t = useTranslations("validation");
  const raw = error ? String(error?.message ?? "") : children;
  // Schema validation messages are `validation.*` keys, so localize them here;
  // already-localized strings (e.g. mapped server errors) and any non-key
  // fall through unchanged.
  const body = typeof raw === "string" && raw.length > 0 && t.has(raw) ? t(raw) : raw;

  if (!body) {
    return null;
  }

  return (
    <p
      ref={ref}
      id={formMessageId}
      className={cn("text-destructive text-[0.8rem] font-medium", className)}
      {...props}
    >
      {body}
    </p>
  );
});
FormMessage.displayName = "FormMessage";

export {
  useFormField,
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
};
