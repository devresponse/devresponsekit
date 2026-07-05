"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthPolicyForm, type AuthPolicySettingsJson } from "@/components/admin/auth-policy-form";
import { OrganizationMembersGrid } from "./_organization-members-grid";
import { OrganizationProvidersGrid } from "./_organization-providers-grid";
import { OrganizationSettingsForm } from "./_organization-settings-form";

/**
 * Client-side tab container for the organization detail (docs/admin-manager.md §19).
 *
 * Each tab owns its own data fetch; the Authentication tab receives its
 * initial policy rows from the server page (0007).
 */
export interface OrganizationDetailJson {
  id: string;
  slug: string;
  name: string;
  status: string;
  isDefault: boolean;
  memberCount: number;
  bindingCount: number;
}

export function OrganizationDetailTabs({
  org,
  canUpdate,
  authSettings,
  platformAuthDefaults,
}: {
  org: OrganizationDetailJson;
  canUpdate: boolean;
  authSettings: AuthPolicySettingsJson | null;
  platformAuthDefaults: AuthPolicySettingsJson | null;
}) {
  const t = useTranslations("administrator.orgs");

  return (
    <Tabs defaultValue="members" className="w-full">
      <TabsList>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="providers">{t("tabs.providers")}</TabsTrigger>
        <TabsTrigger value="authentication">{t("tabs.authentication")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="members" className="mt-4">
        <OrganizationMembersGrid orgId={org.id} canUpdate={canUpdate} />
      </TabsContent>

      <TabsContent value="providers" className="mt-4">
        <OrganizationProvidersGrid orgId={org.id} canUpdate={canUpdate} />
      </TabsContent>

      <TabsContent value="authentication" className="mt-4">
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

      <TabsContent value="settings" className="mt-4">
        <OrganizationSettingsForm
          orgId={org.id}
          initialSlug={org.slug}
          initialName={org.name}
          initialStatus={org.status}
          initialIsDefault={org.isDefault}
          canUpdate={canUpdate}
        />
      </TabsContent>
    </Tabs>
  );
}
