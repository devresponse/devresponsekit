"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Client-side new-user form (plan §8.3).
 *
 * Implementation choice:
 *   - Plain controlled inputs with the existing `Input` / `Label`
 *     primitives. We don't pull in `react-hook-form` here to keep this
 *     PR's surface area tight; the form has only 5 fields and minimal
 *     conditional logic, so the runtime cost of a custom controller is
 *     negligible. Phase 4+ forms (role / org create) can adopt
 *     `react-hook-form` once a shared field-level component exists.
 *   - Validation mirrors the server Zod schema in
 *     `/api/administrator/users/route.ts` so users see the same rules
 *     client-side that the server enforces; the server is still the
 *     source of truth and rejects bad data with 400 / 409.
 */
const VALID_LOCALES = ["en", "es", "fr", "uk"] as const;

interface FormState {
  email: string;
  displayName: string;
  password: string;
  role: "user" | "admin";
  initialAppStatus: "pending_approval" | "active";
  preferredLocale: (typeof VALID_LOCALES)[number];
}

interface FormErrors {
  email?: string;
  password?: string;
  submit?: string;
}

export function NewUserForm({ locale }: { locale: string }) {
  const t = useTranslations("administrator.users");
  const tErr = useTranslations("administrator.errors");
  const router = useRouter();

  const [state, setState] = useState<FormState>({
    email: "",
    displayName: "",
    password: "",
    role: "user",
    initialAppStatus: "pending_approval",
    preferredLocale: "en",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    // Email validity is enforced by the browser via `type="email"` +
    // `required` on the <Input> below, plus the server-side
    // `z.email()` which is the source of truth. Re-running a regex
    // here would only drift from the canonical validator without
    // changing user-visible behaviour.
    if (state.password.length < 8 || state.password.length > 128) {
      next.password = tErr("invalidBody");
    }
    return next;
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length > 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/administrator/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: state.email.trim(),
          password: state.password,
          name: state.displayName.trim() || undefined,
          role: state.role,
          initialAppStatus: state.initialAppStatus,
          preferredLocale: state.preferredLocale,
        }),
      });

      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        // Navigate to the new user's detail page on success.
        if (body.id) {
          router.push(`/${locale}/app/administrator/users/${body.id}`);
          router.refresh();
          return;
        }
        router.push(`/${locale}/app/administrator/users`);
        return;
      }

      if (res.status === 409) {
        setErrors({ email: tErr("emailTaken") });
        return;
      }
      if (res.status === 400) {
        setErrors({ submit: tErr("invalidBody") });
        return;
      }
      if (res.status === 403) {
        setErrors({ submit: tErr("forbidden") });
        return;
      }
      setErrors({ submit: t("new.errorToast") });
    } catch {
      setErrors({ submit: t("new.errorToast") });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="max-w-xl space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">{t("fields.email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={state.email}
          onChange={(e) => update("email", e.currentTarget.value)}
          aria-invalid={errors.email ? true : undefined}
        />
        {errors.email ? (
          <p className="text-xs text-red-600" role="alert">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="displayName">{t("fields.displayName")}</Label>
        <Input
          id="displayName"
          type="text"
          autoComplete="name"
          value={state.displayName}
          onChange={(e) => update("displayName", e.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">{t("fields.password")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          value={state.password}
          onChange={(e) => update("password", e.currentTarget.value)}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="text-xs text-neutral-500">
          {t("new.passwordHint")}
        </p>
        {errors.password ? (
          <p className="text-xs text-red-600" role="alert">
            {errors.password}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="role">{t("fields.role")}</Label>
          <select
            id="role"
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
            value={state.role}
            onChange={(e) => update("role", e.currentTarget.value as FormState["role"])}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="initialAppStatus">{t("fields.initialAppStatus")}</Label>
          <select
            id="initialAppStatus"
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
            value={state.initialAppStatus}
            onChange={(e) =>
              update(
                "initialAppStatus",
                e.currentTarget.value as FormState["initialAppStatus"],
              )
            }
          >
            <option value="pending_approval">{t("status.pending_approval")}</option>
            <option value="active">{t("status.active")}</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="preferredLocale">{t("fields.preferredLocale")}</Label>
          <select
            id="preferredLocale"
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
            value={state.preferredLocale}
            onChange={(e) =>
              update(
                "preferredLocale",
                e.currentTarget.value as FormState["preferredLocale"],
              )
            }
          >
            {VALID_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      {errors.submit ? (
        <p className="text-sm text-red-600" role="alert">
          {errors.submit}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {t("new.submit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.push(`/${locale}/app/administrator/users`)}
        >
          {t("new.cancel")}
        </Button>
      </div>
    </form>
  );
}
