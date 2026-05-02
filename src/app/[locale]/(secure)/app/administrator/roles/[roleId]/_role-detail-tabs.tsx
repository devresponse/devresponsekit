"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RolePermissionsEditor } from "./_role-permissions-editor";
import { RoleMembersGrid } from "./_role-members-grid";
import { RoleSettingsForm } from "./_role-settings-form";

/**
 * Client-side tab container for the role detail (plan §8.6).
 *
 * Each tab owns its own data fetch except for the Permissions tab,
 * which is hydrated from the server-rendered initial set so the dual-
 * list editor renders the assigned column immediately.
 */
export interface RoleDetailJson {
  id: string;
  organizationId: string | null;
  key: string;
  name: string;
  description: string | null;
  permissionKeys: string[];
  memberCount: number;
}

export function RoleDetailTabs({
  role,
  canUpdate,
}: {
  role: RoleDetailJson;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.roles");

  return (
    <Tabs defaultValue="permissions" className="w-full">
      <TabsList>
        <TabsTrigger value="permissions">{t("tabs.permissions")}</TabsTrigger>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="permissions" className="mt-4">
        <RolePermissionsEditor
          roleId={role.id}
          initialAssigned={role.permissionKeys}
          canUpdate={canUpdate}
        />
      </TabsContent>

      <TabsContent value="members" className="mt-4">
        <RoleMembersGrid roleId={role.id} />
      </TabsContent>

      <TabsContent value="settings" className="mt-4">
        <RoleSettingsForm
          roleId={role.id}
          initialKey={role.key}
          initialName={role.name}
          initialDescription={role.description}
          canUpdate={canUpdate}
        />
      </TabsContent>
    </Tabs>
  );
}
