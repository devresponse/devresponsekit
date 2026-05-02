"use client";

import { useTranslations, useLocale } from "next-intl";
import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { UserSessionsPanel } from "./_user-sessions-panel";

/**
 * Client-side tab container for the user detail page (plan §8.4).
 *
 * The Overview tab renders read-only metadata that the parent RSC has
 * already streamed in (no client fetch). The Sessions and Audit tabs
 * own their own data fetches so heavy reads only happen when the user
 * opens that tab. Roles and Memberships render as "coming soon"
 * placeholders until Phases 4-5 land their data sources.
 */
export interface UserDetailJson {
  id: string;
  better_auth_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
  status_reason: string | null;
  preferred_locale: string;
  created_at: string | null;
  updated_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivated_reason: string | null;
}

export function UserDetailTabs({ user }: { user: UserDetailJson }) {
  const t = useTranslations("administrator.users");
  const locale = useLocale();

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const formatDate = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : fmt.format(d);
  };

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
        <TabsTrigger value="roles">{t("tabs.roles")}</TabsTrigger>
        <TabsTrigger value="memberships">{t("tabs.memberships")}</TabsTrigger>
        <TabsTrigger value="sessions">{t("tabs.sessions")}</TabsTrigger>
        <TabsTrigger value="audit">{t("tabs.audit")}</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="mt-4 space-y-3">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label={t("fields.email")} value={user.primary_email} />
          <Field label={t("fields.displayName")} value={user.display_name ?? "—"} />
          <Field label={t("fields.preferredLocale")} value={user.preferred_locale} />
          <Field
            label={t("detail.appUserId")}
            value={<code className="text-xs">{user.id}</code>}
          />
          <Field
            label={t("detail.betterAuthId")}
            value={<code className="text-xs">{user.better_auth_user_id}</code>}
          />
          {user.status_reason ? (
            <Field label={t("fields.reason")} value={user.status_reason} />
          ) : null}
        </dl>
        <Separator />
        <p className="text-xs text-neutral-500">
          {t("detail.metaCreated", { value: formatDate(user.created_at) })} ·{" "}
          {t("detail.metaUpdated", { value: formatDate(user.updated_at) })}
        </p>
        {user.deactivated_at ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <p>{t("detail.deactivated", { value: formatDate(user.deactivated_at) })}</p>
            {user.deactivated_by ? (
              <p>{t("detail.deactivatedBy", { actor: user.deactivated_by })}</p>
            ) : null}
            {user.deactivated_reason ? (
              <p>{t("detail.deactivatedReason", { reason: user.deactivated_reason })}</p>
            ) : null}
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="roles" className="mt-4 text-sm text-neutral-600">
        {/* Phase 4 placeholder. */}
        <p>—</p>
      </TabsContent>
      <TabsContent value="memberships" className="mt-4 text-sm text-neutral-600">
        {/* Phase 5 placeholder. */}
        <p>—</p>
      </TabsContent>

      <TabsContent value="sessions" className="mt-4">
        <UserSessionsPanel userId={user.id} />
      </TabsContent>

      <TabsContent value="audit" className="mt-4 text-sm text-neutral-600">
        {/* Phase 6 placeholder — will render the audit grid filtered by app_user_id. */}
        <p>—</p>
      </TabsContent>
    </Tabs>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
