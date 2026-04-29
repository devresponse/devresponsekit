/**
 * Deterministic test data factories.
 *
 * Tests MUST use these helpers instead of inline literals so that
 * adding required fields to a domain type breaks all consumers in one
 * place. Factories accept partial overrides for scenario-specific tweaks.
 */
import type { UserAccessContext } from "@/lib/auth-status";
import type {
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
} from "@/components/navigation/menu-types";

export function makeUserAccessContext(
  overrides: Partial<UserAccessContext> = {},
): UserAccessContext {
  return {
    appUserId: "00000000-0000-0000-0000-000000000001",
    primaryEmail: "user@example.com",
    status: "active",
    organizationId: "00000000-0000-0000-0000-000000000002",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["shell.view"],
    ...overrides,
  };
}

export function makeEnterpriseApplicationMenuItem(
  overrides: Partial<EnterpriseApplicationMenuItem> = {},
): EnterpriseApplicationMenuItem {
  return {
    id: "portal",
    label: "Portal",
    description: "Primary enterprise portal",
    environment: "production",
    subdomain: "portal",
    origin: "https://portal.devresponse.com",
    ssoLaunchUrl: "/api/sso/launch?applicationId=portal&locale=en",
    status: "available",
    ...overrides,
  };
}

export function makeNavigationMenuItem(
  overrides: Partial<NavigationMenuItem> = {},
): NavigationMenuItem {
  return {
    id: "dashboard",
    label: "Dashboard",
    href: "/en/app/dashboard",
    ...overrides,
  };
}

export function makeApplicationsMenuResponse(
  items: EnterpriseApplicationMenuItem[] = [makeEnterpriseApplicationMenuItem()],
): NavigationMenuResponse<EnterpriseApplicationMenuItem> {
  return {
    menuId: "applications",
    kind: "applications",
    locale: "en",
    generatedAt: "2026-01-01T00:00:00.000Z",
    items,
  };
}

/**
 * Loaded English message bundle. Tests render components inside
 * `NextIntlClientProvider` with these messages so accessible names match
 * the translated copy users actually see.
 */
import enMessages from "@/messages/en.json";
export const TEST_MESSAGES = enMessages;
