/**
 * Account section registry.
 *
 * Single source of truth for the self-service Account app's navigation.
 * Both the {@link AccountSidebar} and the account landing page render
 * from this list, so adding a future personal-data area (Notifications,
 * Connected accounts, API tokens, Data export, …) is a ONE-entry change:
 * append a descriptor here and add the matching route folder.
 *
 * Every section requires only the baseline secure permission
 * (`shell.view`) — the Account app is user-level and never gates on any
 * `admin.*` permission. `requires` is kept on the descriptor so future
 * sections can opt into a finer-grained user permission without
 * reworking the renderers.
 */
export interface AccountSection {
  id: string;
  /** Locale-less app path. */
  href: `/${string}`;
  /** `account` message-namespace key for the section title. */
  labelKey: string;
  /** `account` message-namespace key for the short description. */
  descriptionKey: string;
  /**
   * Icon NAME resolved client-side through the allow-list in
   * `src/components/navigation/menu-icons.ts`. Keys used here MUST exist
   * in that map.
   */
  icon: string;
  /** Baseline secure permission; user-level only. */
  requires: ReadonlyArray<string>;
}

export const ACCOUNT_SECTIONS: ReadonlyArray<AccountSection> = [
  {
    id: "overview",
    href: "/app/account",
    labelKey: "sections.overview.title",
    descriptionKey: "sections.overview.description",
    icon: "circle-user",
    requires: ["shell.view"],
  },
  {
    id: "profile",
    href: "/app/account/profile",
    labelKey: "sections.profile.title",
    descriptionKey: "sections.profile.description",
    icon: "id-card",
    requires: ["shell.view"],
  },
  {
    id: "preferences",
    href: "/app/account/preferences",
    labelKey: "sections.preferences.title",
    descriptionKey: "sections.preferences.description",
    icon: "settings",
    requires: ["shell.view"],
  },
  {
    id: "security",
    href: "/app/account/security",
    labelKey: "sections.security.title",
    descriptionKey: "sections.security.description",
    icon: "shield",
    requires: ["shell.view"],
  },
];

/** Sections the caller may see, given their permission set. */
export function getVisibleAccountSections(permissions: ReadonlyArray<string>): AccountSection[] {
  return ACCOUNT_SECTIONS.filter(
    (section) =>
      section.requires.length === 0 ||
      section.requires.some((permission) => permissions.includes(permission)),
  );
}
