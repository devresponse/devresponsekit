"use client";

import { useTranslations, useLocale } from "next-intl";
import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { UserSessionsPanel } from "./_user-sessions-panel";
import { UserMembershipsPanel } from "./_user-memberships-panel";
import { UserRolesPanel } from "./_user-roles-panel";
import { UserGroupsPanel } from "./_user-groups-panel";
import { UserAuditPanel } from "./_user-audit-panel";

/**
 * Client-side tab container for the user detail page (docs/admin-manager.md §8.1).
 *
 * The Overview tab renders read-only metadata that the parent RSC has
 * already streamed in (no client fetch). The Roles, Memberships, Sessions,
 * and Audit tabs own their own data fetches so heavy reads only happen when
 * the user opens that tab.
 *
 * A tab whose API demands MORE than `admin.users.read` is rendered only for a
 * caller who holds that permission (review #76): Sessions needs
 * `admin.users.sessions`, Groups needs `admin.groups.read`, Audit needs
 * `admin.audit.read`. The parent RSC derives each flag; showing the tab to
 * everyone did not leak anything (the API is the boundary) but walked a
 * permitted reader straight into a 403.
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
  /** Display name / email resolved from {@link deactivated_by} by the RSC;
   *  falls back to the raw id when the actor cannot be resolved (#212). */
  deactivated_by_label: string | null;
  deactivated_reason: string | null;
}

export function UserDetailTabs({
  user,
  canReadSessions,
  canReadGroups,
  canAssignRoles,
  canManageGroups,
  canUpdateMemberships,
  canReadAudit,
}: {
  user: UserDetailJson;
  canReadSessions: boolean;
  canReadGroups: boolean;
  canAssignRoles: boolean;
  canManageGroups: boolean;
  canUpdateMemberships: boolean;
  canReadAudit: boolean;
}) {
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
        {canReadGroups ? <TabsTrigger value="groups">{t("tabs.groups")}</TabsTrigger> : null}
        <TabsTrigger value="memberships">{t("tabs.memberships")}</TabsTrigger>
        {canReadSessions ? <TabsTrigger value="sessions">{t("tabs.sessions")}</TabsTrigger> : null}
        {canReadAudit ? <TabsTrigger value="audit">{t("tabs.audit")}</TabsTrigger> : null}
      </TabsList>

      <TabsContent value="overview" className="mt-4 space-y-3">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label={t("fields.email")} value={user.primary_email} />
          <Field label={t("fields.displayName")} value={user.display_name ?? "—"} />
          <Field label={t("fields.preferredLocale")} value={user.preferred_locale} />
          <Field label={t("detail.appUserId")} value={<code className="text-xs">{user.id}</code>} />
          <Field
            label={t("detail.betterAuthId")}
            value={<code className="text-xs">{user.better_auth_user_id}</code>}
          />
          {user.status_reason ? (
            <Field label={t("fields.reason")} value={user.status_reason} />
          ) : null}
        </dl>
        <Separator />
        <p className="text-muted-foreground text-xs">
          {t("detail.metaCreated", { value: formatDate(user.created_at) })} ·{" "}
          {t("detail.metaUpdated", { value: formatDate(user.updated_at) })}
        </p>
        {user.deactivated_at ? (
          <div className="border-warning/40 bg-warning/10 text-warning-foreground rounded-md border p-3 text-xs">
            <p>{t("detail.deactivated", { value: formatDate(user.deactivated_at) })}</p>
            {user.deactivated_by ? (
              // Prefer the resolved name; the raw Better Auth id is the
              // last-resort fallback (review #212).
              <p>
                {t("detail.deactivatedBy", {
                  actor: user.deactivated_by_label ?? user.deactivated_by,
                })}
              </p>
            ) : null}
            {user.deactivated_reason ? (
              <p>{t("detail.deactivatedReason", { reason: user.deactivated_reason })}</p>
            ) : null}
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="roles" className="mt-4">
        <UserRolesPanel userId={user.id} canAssign={canAssignRoles} />
      </TabsContent>
      {canReadGroups ? (
        <TabsContent value="groups" className="mt-4">
          <UserGroupsPanel userId={user.id} canManage={canManageGroups} />
        </TabsContent>
      ) : null}
      <TabsContent value="memberships" className="mt-4">
        <UserMembershipsPanel userId={user.id} canUpdate={canUpdateMemberships} />
      </TabsContent>

      {canReadSessions ? (
        <TabsContent value="sessions" className="mt-4">
          <UserSessionsPanel userId={user.id} />
        </TabsContent>
      ) : null}

      {canReadAudit ? (
        <TabsContent value="audit" className="mt-4">
          <UserAuditPanel userId={user.id} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
