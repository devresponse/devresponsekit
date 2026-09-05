import type { AppStatus } from "@/lib/admin/enterprise-apps";

/**
 * Navigation menu envelope and item types.
 *
 * Used by both the API route handlers and the client-side navigation
 * helper. UI components MUST receive these shapes via API responses
 * rather than importing menu arrays directly.
 */

export interface NavigationMenuResponse<TItem> {
  menuId: string;
  kind: string;
  locale: string;
  generatedAt: string;
  items: TItem[];
}

export interface NavigationMenuItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  badge?: string;
}

export interface EnterpriseApplicationMenuItem {
  id: string;
  label: string;
  description?: string;
  environment: "production" | "staging" | "development";
  subdomain: string;
  origin: string;
  ssoLaunchUrl: string;
  /**
   * Derived from `APP_STATUS_VALUES` — ONE state model (review #63). The
   * switcher only ever lists `available` apps (launch rejects anything else),
   * and the column's CHECK (migration 0004) admits `available` | `disabled`.
   */
  status: AppStatus;
  active?: boolean;
}
