"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  type AuthPolicySettingsInput,
} from "@/lib/validation/auth-policy";
import { useSavedFormBaseline } from "@/lib/forms/use-saved-form-baseline";

/**
 * JSON-safe view of a signup-policy row, passed from RSC pages
 * (docs/admin-manager.md).
 */
export interface AuthPolicySettingsJson {
  requireEmailVerification: boolean;
  signupApprovalMode: AuthPolicyApprovalMode;
  allowedAuthMethods: AuthPolicyMethod[] | null;
  autoApproveEmailDomains: string[] | null;
}

/**
 * The fail-closed baseline, mirrored from `FAIL_CLOSED_AUTH_POLICY`
 * (server-only).
 *
 * This is a starting point for an EDITABLE form only. It must never be
 * rendered as a read-only statement of the policy in effect: review #72
 * stopped streaming the platform defaults to non-superadmins, so
 * `platformDefaults` is now legitimately `null` ("withheld"), and
 * substituting this baseline in the inherit summary told an org admin their
 * org requires verification + admin approval when the real platform default
 * may be the exact opposite. See {@link AuthPolicyForm}.
 */
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
 *
 * `platformDefaults === null` means WITHHELD, not "strict". The RSC only
 * loads the platform default for a superadmin or for an org that already
 * inherits (review #72), so a non-superadmin editing an override never
 * receives it. The inherit view therefore says "inherits the platform
 * default" WITHOUT a summary in that case: rendering `STRICT_DEFAULTS`
 * there stated a policy the platform may not have (the follow-up finding to
 * #72 — it is reachable through Reset, which is the only path into the
 * inherit view while the defaults are withheld). `router.refresh()` after a
 * successful Reset re-runs the RSC, which — the override now gone — streams
 * the real defaults back, so the summary appears on its own.
 *
 * F-39: on the organization detail this form lives in a Radix tab panel, which
 * unmounts when another tab is opened and remounts from the page's props. A
 * successful Save only used to flip local state, so after a tab switch an org
 * that had just been given an override showed the "inherits the platform
 * default" view (misstating its live sign-in policy), and an edited override
 * showed its pre-save values. Save now goes through `useSavedFormBaseline`
 * (the baseline moves and the page refreshes, as Reset already did), and the
 * override flags below follow `initialSettings`, so the refreshed props, even
 * when they land after a remount, put the form back on the saved policy (and,
 * after a Reset, back on the inherit view, unless the admin has already opened
 * Customize again). The PATCH still carries the COMPLETE policy: the route has
 * no partial contract.
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

  const router = useRouter();
  // What the org inherits, when we are allowed to know it. `null` = withheld
  // (see the component doc) — the summary must then say so rather than
  // pretend the baseline is the answer.
  const inheritedView = platformDefaults ?? null;
  // Editing baseline only: a form the admin is about to fill in starts from
  // the fail-closed policy when the real default is not disclosed. Nothing is
  // saved until they press Save, so this states nothing about the platform.
  const editBaseline = inheritedView ?? STRICT_DEFAULTS;
  const [hasRow, setHasRow] = useState(initialSettings !== null);
  const [editing, setEditing] = useState(scope === "platform" || initialSettings !== null);
  const [notice, setNotice] = useState<"saved" | "reset" | null>(null);

  // F-39: whether the org has an override is the SERVER's answer. When the
  // refreshed props change it (a save gave the org one, a reset took it away),
  // adopt it; state adjusted during render, so the inherit view is never
  // painted over a live override once the props say otherwise.
  //
  // One exception: an unsaved Customize (the editor is open, but no override
  // is saved yet, so it was opened from the inherit view) stays open. Reset's
  // refresh can land AFTER the admin has already pressed Customize and started
  // editing; closing the editor then would throw the edit away (Customize
  // re-seeds the form). A form that is open because of an override the props
  // no longer have, such as a remount from the stale props after Reset, still
  // closes. In the organization scope `hasRow` implies `editing` (every path
  // that sets one sets the other), so `editing && !hasRow` is exactly that
  // unsaved Customize.
  const settingsKey = JSON.stringify(initialSettings);
  const [syncedSettingsKey, setSyncedSettingsKey] = useState(settingsKey);
  if (syncedSettingsKey !== settingsKey) {
    const customizing = scope === "organization" && editing && !hasRow;
    setSyncedSettingsKey(settingsKey);
    setHasRow(initialSettings !== null);
    setEditing(scope === "platform" || initialSettings !== null || customizing);
  }

  const { form, commitSaved } = useSavedFormBaseline<AuthPolicyFormInput, AuthPolicySettingsInput>(
    authPolicyFormSchema,
    toFormValues(initialSettings ?? (scope === "platform" ? null : editBaseline)),
    toAuthPolicyApiBody,
  );

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
        commitSaved(values);
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
        form.reset(toFormValues(editBaseline));
        // Re-run the RSC: with the override gone the page is allowed to load
        // the platform default again, so the inherit summary can show the
        // REAL inherited policy instead of nothing.
        router.refresh();
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
        {inheritedView ? (
          <PolicySummary settings={inheritedView} />
        ) : (
          <p className="text-muted-foreground text-sm">{t("inheritUnknown")}</p>
        )}
        {notice === "reset" ? (
          <p className="text-success text-sm" role="status">
            {t("resetDone")}
          </p>
        ) : null}
        {canUpdate ? (
          <Button
            type="button"
            onClick={() => {
              form.reset(toFormValues(editBaseline));
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
  // The most permissive combination: auto-activate everyone AND waive email
  // proof, so anyone who submits the form gets immediate access. Gates the
  // `openSignupWarning` callout below.
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
