import {
  AppWindow,
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Circle,
  CircleUser,
  FileText,
  Home,
  IdCard,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  Mail,
  MailOpen,
  ScrollText,
  Settings,
  Shield,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

/**
 * Allow-list mapping from the `icon` names served by the navigation
 * menu API (`NavigationMenuItem.icon`) to lucide-react components.
 *
 * The API intentionally returns icon *names* as plain strings — the
 * server must never emit component code, and the client must never
 * resolve arbitrary identifiers against the full lucide export (which
 * would let a compromised menu row pull in any icon and defeat
 * tree-shaking). Adding a menu icon therefore means adding one entry
 * here AND using its key in `DEFAULT_SHELL_MENU` / the database row.
 */
export const MENU_ICONS: Record<string, LucideIcon> = {
  "layout-dashboard": LayoutDashboard,
  briefcase: Briefcase,
  shield: Shield,
  users: Users,
  "scroll-text": ScrollText,
  settings: Settings,
  // Administrator workspace navigation.
  home: Home,
  "key-round": KeyRound,
  "key-square": KeySquare,
  "building-2": Building2,
  "users-round": UsersRound,
  "app-window": AppWindow,
  bot: Bot,
  mail: Mail,
  "mail-open": MailOpen,
  // Account (self-service) workspace.
  "circle-user": CircleUser,
  "id-card": IdCard,
  // Documentation viewer.
  "book-open": BookOpen,
  "file-text": FileText,
};

/**
 * Rendered when a menu item names an icon this build does not know —
 * a visible-but-generic glyph keeps icon-only collapsed layouts
 * aligned instead of collapsing the slot.
 */
export const FALLBACK_MENU_ICON: LucideIcon = Circle;

/**
 * Resolves a menu item's icon name to a component.
 *
 * - `undefined` / empty name → `null` (item simply has no icon).
 * - Unknown name → {@link FALLBACK_MENU_ICON}.
 */
export function getMenuIcon(name: string | undefined): LucideIcon | null {
  if (!name) return null;
  return MENU_ICONS[name] ?? FALLBACK_MENU_ICON;
}
