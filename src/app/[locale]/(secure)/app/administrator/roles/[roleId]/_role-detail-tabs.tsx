"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger, useKeptTabs } from "@/components/ui/tabs";
import { RolePermissionsEditor } from "./_role-permissions-editor";
import { RoleMembersGrid } from "./_role-members-grid";
import { RoleSettingsForm } from "./_role-settings-form";

/**
 * Client-side tab container for the role detail (docs/admin-manager.md §8.4).
 *
 * Each tab owns its own data fetch except for the Permissions tab,
 * which is hydrated from the server-rendered initial set so the dual-
 * list editor renders the assigned column immediately.
 *
 * The Permissions editor and the Settings form stay mounted while another tab
 * is open (`useKeptTabs`, F-158), so staged moves and typed edits survive a
 * look at Members; Radix used to unmount them and discard both. Both still
 * refresh the page after a save and follow the refreshed props (F-39); a new
 * panel seeded from props must do the same.
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

export function RoleDetailTabs({ role, canUpdate }: { role: RoleDetailJson; canUpdate: boolean }) {
  const t = useTranslations("administrator.roles");
  const tabs = useKeptTabs("permissions");

  return (
    <Tabs {...tabs.root} className="w-full">
      <TabsList>
        <TabsTrigger value="permissions">{t("tabs.permissions")}</TabsTrigger>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="permissions" className="mt-4" {...tabs.keep("permissions")}>
        <RolePermissionsEditor
          roleId={role.id}
          initialAssigned={role.permissionKeys}
          canUpdate={canUpdate}
        />
      </TabsContent>

      <TabsContent value="members" className="mt-4">
        <RoleMembersGrid roleId={role.id} />
      </TabsContent>

      <TabsContent value="settings" className="mt-4" {...tabs.keep("settings")}>
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
