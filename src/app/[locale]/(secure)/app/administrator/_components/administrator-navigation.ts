export interface AdministratorNavigationItem {
  id: string;
  href: `/${string}`;
  labelKey: string;
  /**
   * Icon NAME resolved client-side through the allow-list in
   * `src/components/navigation/menu-icons.ts`. Keys used here MUST
   * exist in that map.
   */
  icon: string;
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
        icon: "home",
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
        icon: "users",
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
        icon: "shield",
        requires: ["admin.roles.read"],
      },
      {
        id: "permissions",
        href: "/app/administrator/permissions",
        labelKey: "permissions",
        icon: "key-round",
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
        icon: "building-2",
        requires: ["admin.orgs.read"],
      },
      {
        id: "memberships",
        href: "/app/administrator/memberships",
        labelKey: "memberships",
        icon: "users-round",
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
        icon: "app-window",
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
    id: "apis",
    labelKey: "apis",
    items: [
      {
        id: "api-keys",
        href: "/app/administrator/api-keys",
        labelKey: "apiKeys",
        icon: "key-round",
        requires: ["admin.apikeys.read"],
      },
    ],
    actions: [],
  },
  {
    id: "communication",
    labelKey: "communication",
    items: [
      {
        id: "email-outbox",
        href: "/app/administrator/email",
        labelKey: "emailOutbox",
        icon: "mail",
        requires: ["admin.email.read"],
      },
      {
        id: "email-templates",
        href: "/app/administrator/email/templates",
        labelKey: "emailTemplates",
        icon: "mail-open",
        requires: ["admin.email.read"],
      },
    ],
    actions: [],
  },
  {
    id: "activity",
    labelKey: "activity",
    items: [
      {
        id: "audit",
        href: "/app/administrator/audit",
        labelKey: "auditLog",
        icon: "scroll-text",
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
    actions: group.actions.filter((action) =>
      hasAdministratorPermission(permissions, action.requires),
    ),
  })).filter((group) => group.items.length > 0 || group.actions.length > 0);
}
