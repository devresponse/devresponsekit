"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUTH_POLICY_METHODS,
  authPolicyFormSchema,
  toAuthPolicyApiBody,
  type AuthPolicyApprovalMode,
  type AuthPolicyFormInput,
  type AuthPolicyMethod,
} from "@/lib/validation/auth-policy";
import { useZodForm } from "@/lib/forms/use-zod-form";

/**
 * JSON-safe view of a signup-policy row, passed from RSC pages
 * (docs/admin-manager.md; migration 0007).
 */
export interface AuthPolicySettingsJson {
  requireEmailVerification: boolean;
  signupApprovalMode: AuthPolicyApprovalMode;
  allowedAuthMethods: AuthPolicyMethod[] | null;
  autoApproveEmailDomains: string[] | null;
}

/** The fail-closed baseline, mirrored from `FAIL_CLOSED_AUTH_POLICY` (server-only). */
const STRICT_DEFAULTS: AuthPolicySettingsJson = {
  requireEmailVerification: true,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: null,
  autoApproveEmailDomains: null,
};

const METHOD_LABEL_KEY: Record<AuthPolicyMethod, string> = {
  email: "methodEmail",
  google: "methodGoogle",
  microsoft: "methodMicrosoft",
  github: "methodGithub",
};

function toFormValues(settings: AuthPolicySettingsJson | null): AuthPolicyFormInput {
  const v = settings ?? STRICT_DEFAULTS;
  return {
    requireEmailVerification: v.requireEmailVerification,
    signupApprovalMode: v.signupApprovalMode,
    restrictMethods: v.allowedAuthMethods !== null,
    // When unrestricted, pre-check every method so enabling the restriction
    // starts from "all allowed" and the admin narrows down.
    allowedAuthMethods: v.allowedAuthMethods ?? [...AUTH_POLICY_METHODS],
    autoApproveEmailDomainsText: (v.autoApproveEmailDomains ?? []).join(", "),
  };
}

/**
 * Signup-policy editor (0007) — shared by the organization detail's
 * Authentication tab (scope "organization", PATCH/DELETE
 * `/api/administrator/organizations/:id/auth-settings`) and the superadmin
 * platform-defaults card (scope "platform", PATCH
 * `/api/administrator/auth-settings/defaults`).
 *
 * An org without an override shows an "inheriting platform defaults"
 * summary; Customize opens the form pre-filled from those defaults, and
 * Reset (DELETE) returns to inheritance. The platform scope always edits —
 * the baseline row cannot be deleted.
 */
export function AuthPolicyForm({
  endpoint,
  scope,
  initialSettings,
  platformDefaults,
  canUpdate,
}: {
  endpoint: string;
  scope: "organization" | "platform";
  initialSettings: AuthPolicySettingsJson | null;
  platformDefaults?: AuthPolicySettingsJson | null;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.authPolicy");
  const tErr = useTranslations("administrator.errors");

  const inheritedView = platformDefaults ?? STRICT_DEFAULTS;
  const [hasRow, setHasRow] = useState(initialSettings !== null);
  const [editing, setEditing] = useState(scope === "platform" || initialSettings !== null);
  const [notice, setNotice] = useState<"saved" | "reset" | null>(null);

  const form = useZodForm<AuthPolicyFormInput>(authPolicyFormSchema, {
    defaultValues: toFormValues(initialSettings ?? (scope === "platform" ? null : inheritedView)),
  });

  const onValid = async (values: AuthPolicyFormInput) => {
    form.clearErrors("root");
    setNotice(null);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toAuthPolicyApiBody(values)),
      });
      if (res.ok) {
        setHasRow(true);
        setNotice("saved");
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
      form.setError("root", { type: "server", message: t("errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("errorToast") });
    }
  };

  const onReset = async () => {
    form.clearErrors("root");
    setNotice(null);
    try {
      const res = await fetch(endpoint, { method: "DELETE", credentials: "same-origin" });
      if (res.ok || res.status === 404) {
        setHasRow(false);
        setEditing(false);
        setNotice("reset");
        form.reset(toFormValues(inheritedView));
        return;
      }
      form.setError("root", { type: "server", message: t("errorToast") });
    } catch {
      form.setError("root", { type: "server", message: t("errorToast") });
    }
  };

  if (scope === "organization" && !editing) {
    return (
      <div className="max-w-xl space-y-4">
        <p className="text-muted-foreground text-sm">{t("inheritBody")}</p>
        <PolicySummary settings={inheritedView} />
        {notice === "reset" ? (
          <p className="text-success text-sm" role="status">
            {t("resetDone")}
          </p>
        ) : null}
        {canUpdate ? (
          <Button
            type="button"
            onClick={() => {
              form.reset(toFormValues(inheritedView));
              setNotice(null);
              setEditing(true);
            }}
          >
            {t("customize")}
          </Button>
        ) : null}
      </div>
    );
  }

  const restrict = form.watch("restrictMethods");
  const openSignup =
    form.watch("signupApprovalMode") === "auto_active" && !form.watch("requireEmailVerification");
  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form} schema={authPolicyFormSchema}>
      <form className="max-w-xl space-y-4" onSubmit={form.handleSubmit(onValid)} noValidate>
        <FormField
          control={form.control}
          name="requireEmailVerification"
          render={({ field }) => (
            <FormItem>
              <div className="flex flex-row items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={!canUpdate}
                  />
                </FormControl>
                <FormLabel className="font-normal">{t("requireVerification")}</FormLabel>
              </div>
              <FormDescription>{t("requireVerificationHelp")}</FormDescription>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="signupApprovalMode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("approvalMode")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="admin_approval">{t("approvalModeAdmin")}</SelectItem>
                  <SelectItem value="auto_active">{t("approvalModeAuto")}</SelectItem>
                  <SelectItem value="invite_only">{t("approvalModeInvite")}</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t("approvalModeHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {openSignup ? (
          <p className="text-warning text-sm" role="note">
            {t("openSignupWarning")}
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="restrictMethods"
          render={({ field }) => (
            <FormItem>
              <div className="flex flex-row items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={!canUpdate}
                  />
                </FormControl>
                <FormLabel className="font-normal">{t("restrictMethods")}</FormLabel>
              </div>
              <FormDescription>{t("restrictMethodsHelp")}</FormDescription>
            </FormItem>
          )}
        />

        {restrict ? (
          <FormField
            control={form.control}
            name="allowedAuthMethods"
            render={({ field }) => (
              <FormItem className="space-y-2 pl-6">
                {AUTH_POLICY_METHODS.map((method) => {
                  const checked = field.value.includes(method);
                  return (
                    <div key={method} className="flex flex-row items-center gap-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          field.onChange(
                            v === true
                              ? [...field.value, method]
                              : field.value.filter((m) => m !== method),
                          )
                        }
                        disabled={!canUpdate}
                        aria-label={t(METHOD_LABEL_KEY[method])}
                      />
                      <span className="text-sm">{t(METHOD_LABEL_KEY[method])}</span>
                    </div>
                  );
                })}
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <FormField
          control={form.control}
          name="autoApproveEmailDomainsText"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("autoApproveDomains")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder="acme.com, example.org"
                  {...field}
                  disabled={!canUpdate}
                />
              </FormControl>
              <FormDescription>{t("autoApproveDomainsHelp")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {rootError ? (
          <p className="text-destructive text-sm" role="alert">
            {rootError}
          </p>
        ) : null}
        {notice === "saved" ? (
          <p className="text-success text-sm" role="status">
            {t("saved")}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!canUpdate || form.formState.isSubmitting}>
            {t("save")}
          </Button>
          {scope === "organization" && hasRow ? (
            <Button
              type="button"
              variant="outline"
              onClick={onReset}
              disabled={!canUpdate || form.formState.isSubmitting}
            >
              {t("reset")}
            </Button>
          ) : null}
          {scope === "organization" && !hasRow ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setNotice(null);
              }}
            >
              {t("cancel")}
            </Button>
          ) : null}
        </div>
      </form>
    </Form>
  );
}

/** Compact read-only rendering of a policy (the inherit summary). */
function PolicySummary({ settings }: { settings: AuthPolicySettingsJson }) {
  const t = useTranslations("administrator.orgs.authPolicy");
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t("summaryVerification")}</dt>
      <dd>{settings.requireEmailVerification ? t("on") : t("off")}</dd>
      <dt className="text-muted-foreground">{t("summaryApproval")}</dt>
      <dd>
        {settings.signupApprovalMode === "auto_active"
          ? t("approvalModeAuto")
          : settings.signupApprovalMode === "invite_only"
            ? t("approvalModeInvite")
            : t("approvalModeAdmin")}
      </dd>
      <dt className="text-muted-foreground">{t("summaryMethods")}</dt>
      <dd>
        {settings.allowedAuthMethods === null
          ? t("allMethods")
          : settings.allowedAuthMethods.map((m) => t(METHOD_LABEL_KEY[m])).join(", ")}
      </dd>
      <dt className="text-muted-foreground">{t("summaryDomains")}</dt>
      <dd>
        {settings.autoApproveEmailDomains === null || settings.autoApproveEmailDomains.length === 0
          ? t("noDomains")
          : settings.autoApproveEmailDomains.join(", ")}
      </dd>
    </dl>
  );
}
