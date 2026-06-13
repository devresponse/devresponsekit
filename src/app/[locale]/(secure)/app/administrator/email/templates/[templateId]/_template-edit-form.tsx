"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Client-side template editor (specs.md §35), following the standard
 * form pattern (`_new-permission-form.tsx`): controlled inputs, client
 * validation mirroring the server Zod schema, submit + Cancel at the
 * bottom — no back link.
 *
 * `{{variable}}` placeholders are substituted at send time; values are
 * HTML-escaped in the HTML body by the renderer, so editors cannot be
 * tricked into producing injectable output via variable values.
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

  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.body_html);
  const [bodyText, setBodyText] = useState(template.body_text ?? "");
  const [description, setDescription] = useState(template.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const listHref = `/${locale}/app/administrator/email/templates`;

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (subject.trim().length === 0 || bodyHtml.trim().length === 0) {
      setError(tErr("invalidBody"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/administrator/email/templates/${template.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          body_html: bodyHtml,
          body_text: bodyText.trim().length > 0 ? bodyText : null,
          description: description.trim().length > 0 ? description.trim() : null,
        }),
      });

      if (res.ok) {
        router.push(listHref);
        router.refresh();
        return;
      }
      if (res.status === 400) {
        setError(tErr("invalidBody"));
        return;
      }
      if (res.status === 403) {
        setError(tErr("forbidden"));
        return;
      }
      setError(t("saveError"));
    } catch {
      setError(t("saveError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-3xl space-y-4" onSubmit={onSubmit} noValidate>
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

      <div className="space-y-2">
        <Label htmlFor="template-subject">{t("fields.subject")}</Label>
        <Input
          id="template-subject"
          type="text"
          required
          maxLength={500}
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="template-body-html">{t("fields.bodyHtml")}</Label>
        <Textarea
          id="template-body-html"
          required
          rows={10}
          className="font-mono text-xs"
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="template-body-text">{t("fields.bodyText")}</Label>
        <Textarea
          id="template-body-text"
          rows={8}
          className="font-mono text-xs"
          value={bodyText}
          onChange={(e) => setBodyText(e.currentTarget.value)}
        />
        <p className="text-muted-foreground text-xs">{t("fields.bodyTextHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="template-description">{t("fields.description")}</Label>
        <Input
          id="template-description"
          type="text"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.push(listHref)}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
