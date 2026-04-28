"use client";

import type {
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
} from "./menu-types";

/**
 * Client-side fetch helpers for navigation API endpoints.
 *
 * Threat / contract:
 *   - These helpers MUST NOT cache responses with stale auth context.
 *     Menus are filtered server-side by session/role/account-status, so
 *     stale data could leak admin-only entries to non-admin users.
 *   - 401/403 responses are surfaced to callers so the UI can show the
 *     correct retry / unauthorized state instead of a blank menu.
 */

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new NavigationApiError(response.status, await response.text().catch(() => ""));
  }
  return (await response.json()) as T;
}

export class NavigationApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Navigation API error (${status})`);
    this.name = "NavigationApiError";
  }
}

export function fetchApplicationsMenu(locale: string) {
  return getJson<NavigationMenuResponse<EnterpriseApplicationMenuItem>>(
    `/api/navigation/applications?locale=${encodeURIComponent(locale)}`,
  );
}

export function fetchShellMenu(scope: string, locale: string) {
  return getJson<NavigationMenuResponse<NavigationMenuItem>>(
    `/api/navigation/shell-menu?scope=${encodeURIComponent(scope)}&locale=${encodeURIComponent(locale)}`,
  );
}

export function fetchNestedAppsMenu(applicationId: string, locale: string) {
  return getJson<NavigationMenuResponse<NavigationMenuItem>>(
    `/api/navigation/nested-apps?applicationId=${encodeURIComponent(applicationId)}&locale=${encodeURIComponent(locale)}`,
  );
}
