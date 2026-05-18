export interface AdministratorNavigationItem {
  id: string;
  href: `/${string}`;
  labelKey: string;
  requires: ReadonlyArray<string>;
}

export type AdministratorNavigationActionId =
  | "new-user"
  | "new-role"
  | "new-organization"
  | "new-enterprise-app";

export interface AdministratorNavigationAction {
  id: AdministratorNavigationActionId;
  href: `/${string}`;
  requires: ReadonlyArray<string>;
}

export interface AdministratorNavigationGroup {
  id: string;
  labelKey: string;
  items: ReadonlyArray<AdministratorNavigationItem>;
  actions: ReadonlyArray<AdministratorNavigationAction>;
}

export interface AdministratorVisibleNavigationGroup {
  id: string;
  labelKey: string;
  items: AdministratorNavigationItem[];
  actions: AdministratorNavigationAction[];
}

export const ADMINISTRATOR_NAV_GROUPS: ReadonlyArray<AdministratorNavigationGroup> = [
  {
    id: "overview",
    labelKey: "overview",
    items: [
      {
        id: "overview-home",
        href: "/app/administrator",
        labelKey: "overview",
        requires: [],
      },
    ],
    actions: [],
  },
  {
    id: "identity",
    labelKey: "identity",
    items: [
      {
        id: "users",
        href: "/app/administrator/users",
        labelKey: "users",
        requires: ["admin.users.read"],
      },
    ],
    actions: [
      {
        id: "new-user",
        href: "/app/administrator/users/new",
        requires: ["admin.users.create"],
      },
    ],
  },
  {
    id: "access",
    labelKey: "access",
    items: [
      {
        id: "roles",
        href: "/app/administrator/roles",
        labelKey: "roles",
        requires: ["admin.roles.read"],
      },
      {
        id: "permissions",
        href: "/app/administrator/permissions",
        labelKey: "permissions",
        requires: ["admin.roles.read"],
      },
    ],
    actions: [
      {
        id: "new-role",
        href: "/app/administrator/roles/new",
        requires: ["admin.roles.create"],
      },
    ],
  },
  {
    id: "tenancy",
    labelKey: "tenancy",
    items: [
      {
        id: "organizations",
        href: "/app/administrator/organizations",
        labelKey: "organizations",
        requires: ["admin.orgs.read"],
      },
      {
        id: "memberships",
        href: "/app/administrator/memberships",
        labelKey: "memberships",
        requires: ["admin.orgs.read"],
      },
    ],
    actions: [
      {
        id: "new-organization",
        href: "/app/administrator/organizations/new",
        requires: ["admin.orgs.create"],
      },
    ],
  },
  {
    id: "apps",
    labelKey: "apps",
    items: [
      {
        id: "enterprise-apps",
        href: "/app/administrator/enterprise-apps",
        labelKey: "enterpriseApps",
        requires: ["admin.apps.read"],
      },
    ],
    actions: [
      {
        id: "new-enterprise-app",
        href: "/app/administrator/enterprise-apps/new",
        requires: ["admin.apps.manage"],
      },
    ],
  },
  {
    id: "activity",
    labelKey: "activity",
    items: [
      {
        id: "audit",
        href: "/app/administrator/audit",
        labelKey: "auditLog",
        requires: ["admin.audit.read"],
      },
    ],
    actions: [],
  },
];

export function hasAdministratorPermission(
  permissions: ReadonlyArray<string>,
  requires: ReadonlyArray<string>,
) {
  return requires.length === 0 || requires.some((permission) => permissions.includes(permission));
}

export function getVisibleAdministratorNavigationGroups(
  permissions: ReadonlyArray<string>,
): AdministratorVisibleNavigationGroup[] {
  return ADMINISTRATOR_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasAdministratorPermission(permissions, item.requires)),
    actions: group.actions.filter((action) => hasAdministratorPermission(permissions, action.requires)),
  })).filter((group) => group.items.length > 0 || group.actions.length > 0);
}