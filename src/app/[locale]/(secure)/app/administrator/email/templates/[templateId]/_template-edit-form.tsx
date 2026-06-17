"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RequiredLegend } from "@/components/ui/required-legend";
import { useZodForm } from "@/lib/forms/use-zod-form";
import {
  updateEmailTemplateSchema,
  type UpdateEmailTemplateInput,
} from "@/lib/validation/email-templates";

/**
 * Email template editor (specs.md §35; docs/form-validation.md). React Hook
 * Form + the shared `updateEmailTemplateSchema` — subject + HTML body are
 * required (asterisks), text body + description optional.
 *
 * `{{variable}}` placeholders are substituted at send time and HTML-escaped by
 * the renderer, so editors cannot produce injectable output via variables.
 */
export interface TemplateEditFormProps {
  locale: string;
  template: {
    id: string;
    subject: string;
    body_html: string;
    body_text: string | null;
    description: string | null;
  };
  /** Variables the flow provides for this key, shown as an editing hint. */
  knownVariables: ReadonlyArray<string>;
}

export function TemplateEditForm({ locale, template, knownVariables }: TemplateEditFormProps) {
  const t = useTranslations("administrator.email.templates");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const listHref = `/${locale}/app/administrator/email/templates`;

  const form = useZodForm<UpdateEmailTemplateInput>(updateEmailTemplateSchema, {
    defaultValues: {
      subject: template.subject,
      body_html: template.body_html,
      body_text: template.body_text ?? "",
      description: template.description ?? "",
    },
  });

  const onValid = async (values: UpdateEmailTemplateInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch(`/api/administrator/email/templates/${template.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: values.subject.trim(),
          body_html: values.body_html,
          body_text: values.body_text?.trim() ? values.body_text : null,
          description: values.description?.trim() ? values.description.trim() : null,
        }),
      });
      if (res.ok) {
        router.push(listHref);
        router.refresh();
        return;
      }
      if (res.status === 400) {
        form.setError("root", { type: "server", message: tErr("invalidBody") });
        return;
      }
      if (res.status === 403) {
        form.setError("root", { type: "server", message: tErr("forbidden") });
        return;
      }
      form.setError("root", { type: "server", message: t("saveError") });
    } catch {
      form.setError("root", { type: "server", message: t("saveError") });
    }
  };

  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={updateEmailTemplateSchema}>
      <form className="max-w-3xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <RequiredLegend />

        {knownVariables.length > 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("variablesHint")}{" "}
            {knownVariables.map((name) => (
              <code key={name} className="bg-muted mr-1 rounded px-1 text-xs">
                {`{{${name}}}`}
              </code>
            ))}
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="subject"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.subject")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="body_html"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.bodyHtml")}</FormLabel>
              <FormControl>
                <Textarea rows={10} className="font-mono text-xs" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="body_text"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.bodyText")}</FormLabel>
              <FormControl>
                <Textarea
                  rows={8}
                  className="font-mono text-xs"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>{t("fields.bodyTextHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.description")}</FormLabel>
              <FormControl>
                <Input type="text" {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={form.formState.isSubmitting}
            onClick={() => router.push(listHref)}
          >
            {t("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
