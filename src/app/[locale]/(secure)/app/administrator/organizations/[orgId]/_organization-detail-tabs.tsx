"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger, useKeptTabs } from "@/components/ui/tabs";
import { AuthPolicyForm, type AuthPolicySettingsJson } from "@/components/admin/auth-policy-form";
import { OrganizationInvitationsPanel } from "./_organization-invitations-panel";
import { OrganizationMembersGrid } from "./_organization-members-grid";
import { OrganizationProvidersGrid } from "./_organization-providers-grid";
import { OrganizationSettingsForm } from "./_organization-settings-form";

/**
 * Client-side tab container for the organization detail (docs/admin-manager.md §8.2).
 *
 * Each tab owns its own data fetch; the Authentication tab receives its
 * initial policy rows from the server page.
 *
 * The Authentication and Settings forms stay mounted while another tab is open
 * (`useKeptTabs`, F-158): Radix used to unmount them, so a tab switch discarded
 * any unsaved edit. Both save through `useSavedFormBaseline` (F-39), which
 * refreshes the page after a save and follows the refreshed props; a new panel
 * seeded from props must do the same.
 *
 * Every flag is a boolean the server page derives from the caller's access
 * context. `canUpdate` (`admin.orgs.update`) governs the org-scoped writes;
 * the Settings form writes the organization row itself, which is
 * SUPERADMIN-only, so it has its own `canEditSettings` (F-66). `canReadRoles`
 * and `canReadUsers` gate what reads another area's API or links to another
 * area's page (F-67).
 */
export interface OrganizationDetailJson {
  id: string;
  slug: string;
  name: string;
  status: string;
  isDefault: boolean;
  /** THE default (where unmapped sign-ups resolve), not just flagged (F-40). */
  isResolvedDefault: boolean;
  memberCount: number;
  bindingCount: number;
}

export function OrganizationDetailTabs({
  org,
  canUpdate,
  canEditSettings,
  canReadRoles,
  canReadUsers,
  authSettings,
  platformAuthDefaults,
}: {
  org: OrganizationDetailJson;
  canUpdate: boolean;
  canEditSettings: boolean;
  canReadRoles: boolean;
  canReadUsers: boolean;
  authSettings: AuthPolicySettingsJson | null;
  platformAuthDefaults: AuthPolicySettingsJson | null;
}) {
  const t = useTranslations("administrator.orgs");
  const tabs = useKeptTabs("members");

  return (
    <Tabs {...tabs.root} className="w-full">
      <TabsList>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="providers">{t("tabs.providers")}</TabsTrigger>
        <TabsTrigger value="authentication">{t("tabs.authentication")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="members" className="mt-4">
        <div className="space-y-6">
          <OrganizationMembersGrid
            orgId={org.id}
            canUpdate={canUpdate}
            canReadUsers={canReadUsers}
          />
          <OrganizationInvitationsPanel
            orgId={org.id}
            canUpdate={canUpdate}
            canReadRoles={canReadRoles}
          />
        </div>
      </TabsContent>

      <TabsContent value="providers" className="mt-4">
        <OrganizationProvidersGrid orgId={org.id} canUpdate={canUpdate} />
      </TabsContent>

      <TabsContent value="authentication" className="mt-4" {...tabs.keep("authentication")}>
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">{t("authPolicy.description")}</p>
          <AuthPolicyForm
            endpoint={`/api/administrator/organizations/${org.id}/auth-settings`}
            scope="organization"
            initialSettings={authSettings}
            platformDefaults={platformAuthDefaults}
            canUpdate={canUpdate}
          />
        </div>
      </TabsContent>

      <TabsContent value="settings" className="mt-4" {...tabs.keep("settings")}>
        <OrganizationSettingsForm
          orgId={org.id}
          initialSlug={org.slug}
          initialName={org.name}
          initialStatus={org.status}
          initialIsDefault={org.isDefault}
          isResolvedDefault={org.isResolvedDefault}
          canUpdate={canEditSettings}
        />
      </TabsContent>
    </Tabs>
  );
}
