"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger, useKeptTabs } from "@/components/ui/tabs";
import { GroupRolesEditor } from "./_group-roles-editor";
import { GroupMembersGrid } from "./_group-members-grid";
import { GroupSettingsForm } from "./_group-settings-form";

export interface GroupDetailJson {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** The group's ETag (F-39), for the Settings form's `If-Match`. */
  etag: string;
}

/**
 * Tab container for the group detail (ADR-0002): Roles (the roles the group
 * confers), Members (users in the group), Settings (name/description).
 *
 * Roles and Members fetch on mount; the Settings form is seeded from these
 * props, so it saves through `useSavedFormBaseline` (F-39), which refreshes the
 * page after a save and follows the refreshed props. The Roles editor and the
 * Settings form stay mounted while another tab is open (`useKeptTabs`,
 * F-158): Radix used to unmount them and discard staged moves and typed edits.
 *
 * `canReadRoles` and `canReadUsers` are the permissions of the OTHER areas
 * these tabs read or link to (F-67); the server page derives them.
 */
export function GroupDetailTabs({
  group,
  canUpdate,
  canAssign,
  canReadRoles,
  canReadUsers,
}: {
  group: GroupDetailJson;
  canUpdate: boolean;
  canAssign: boolean;
  canReadRoles: boolean;
  canReadUsers: boolean;
}) {
  const t = useTranslations("administrator.groups");
  const tabs = useKeptTabs("roles");

  return (
    <Tabs {...tabs.root} className="w-full">
      <TabsList>
        <TabsTrigger value="roles">{t("tabs.roles")}</TabsTrigger>
        <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
        <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
      </TabsList>

      <TabsContent value="roles" className="mt-4" {...tabs.keep("roles")}>
        <GroupRolesEditor groupId={group.id} canAssign={canAssign} canReadRoles={canReadRoles} />
      </TabsContent>

      <TabsContent value="members" className="mt-4">
        <GroupMembersGrid groupId={group.id} canAssign={canAssign} canReadUsers={canReadUsers} />
      </TabsContent>

      <TabsContent value="settings" className="mt-4" {...tabs.keep("settings")}>
        <GroupSettingsForm
          groupId={group.id}
          initialKey={group.key}
          initialName={group.name}
          initialDescription={group.description}
          etag={group.etag}
          canUpdate={canUpdate}
        />
      </TabsContent>
    </Tabs>
  );
}
