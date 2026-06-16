"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GroupRolesEditor } from "./_group-roles-editor";
import { GroupMembersGrid } from "./_group-members-grid";
import { GroupSettingsForm } from "./_group-settings-form";

export interface GroupDetailJson {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

/**
 * Tab container for the group detail (ADR-0002): Roles (the roles the group
 * confers), Members (users in the group), Settings (name/description).
 */
export function GroupDetailTabs({
  group,
  canUpdate,
  canAssign,
}: {
  group: GroupDetailJson;
  canUpdate: boolean;
  canAssign: boolean;
}) {
  const t = useTranslations("administrator.groups");

  return (
    <Tabs defaultValue="roles" className="w-full">
      <TabsList>
        <TabsTrigger value="roles">{t("tabs.roles")}</TabsTrigger>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="roles" className="mt-4">
        <GroupRolesEditor groupId={group.id} canAssign={canAssign} />
      </TabsContent>

      <TabsContent value="members" className="mt-4">
        <GroupMembersGrid groupId={group.id} />
      </TabsContent>

      <TabsContent value="settings" className="mt-4">
        <GroupSettingsForm
          groupId={group.id}
          initialKey={group.key}
          initialName={group.name}
          initialDescription={group.description}
          canUpdate={canUpdate}
        />
      </TabsContent>
    </Tabs>
  );
}
