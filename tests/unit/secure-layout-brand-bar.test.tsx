import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SecureLayout from "@/app/[locale]/(secure)/layout";
import { ApplicationSwitcherSheet } from "@/components/app-shell/application-switcher-sheet";
import { BrandLogo } from "@/components/brand/brand-logo";
import { LocaleLink } from "@/components/i18n/locale-link";
import { getBrand } from "@/config/brand";
import { ANY_ADMIN_PERMISSION, SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";

/**
 * NAVK: the secure brand bar. The brand links to this app's home, and the app
 * switcher gets an `adminConsoleHref` exactly when the caller passes the
 * console's guard (tests/unit/admin-console-gate.test.ts pins that rule).
 *
 * The layout is called, not rendered: its JSX is walked as an element tree,
 * so the shell's client components never run and only the layout's own reads
 * are stubbed. Node environment, since the layout's server-only imports refuse
 * to load where `window` exists.
 */
const state = vi.hoisted(() => ({ permissions: [] as string[] }));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/auth-guard", () => ({
  requireSecureSession: async () => ({
    session: { user: { id: "ba-1" }, session: { id: "s-1" } },
    access: {
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: state.permissions,
    },
  }),
  getImpersonatorId: () => null,
}));
vi.mock("@/lib/active-org.server", () => ({ listUserActiveOrganizations: async () => [] }));
vi.mock("@/lib/impersonation-reach.server", () => ({
  listImpersonationReachableOrgIds: async () => null,
}));

beforeEach(() => {
  state.permissions = ["shell.view"];
});
afterEach(() => vi.clearAllMocks());

/** Every element in the tree, through `children` and element-valued props. */
function elements(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as Record<string, unknown>;
  return [node, ...Object.values(props).flatMap(elements)];
}

async function brandBar(locale: string) {
  const tree = await SecureLayout({
    children: <p>page</p>,
    params: Promise.resolve({ locale }),
  });
  const all = elements(tree);
  const switchers = all.filter((el) => el.type === ApplicationSwitcherSheet);
  const brandLinks = all.filter(
    (el) =>
      el.type === LocaleLink &&
      elements((el.props as { children?: ReactNode }).children).some((c) => c.type === BrandLogo),
  );
  expect(switchers).toHaveLength(1);
  expect(brandLinks).toHaveLength(1);
  return { switcher: switchers[0]!, brandLink: brandLinks[0]! };
}

describe("secure brand bar (NAVK)", () => {
  it("links the brand to this app's home", async () => {
    const { brandLink } = await brandBar("fr");
    expect(brandLink.props).toMatchObject({ href: "/app", locale: "fr" });

    // Rendered, the locale-aware link resolves to /fr/app, named by the brand.
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={{}}>
        {brandLink}
      </NextIntlClientProvider>,
    );
    expect(html).toMatch(/^<a [^>]*href="\/fr\/app"[^>]*>/);
    expect(html).toContain(`>${getBrand().shortName}</span></a>`);
  });

  it("passes the switcher no console href for a caller without an admin permission", async () => {
    state.permissions = ["shell.view", "audit.view"];
    const { switcher } = await brandBar("en");
    expect(switcher.props).toEqual({ locale: "en", adminConsoleHref: undefined });
  });

  it.each([
    ["an org admin with one admin key", ["shell.view", "admin.audit.read"]],
    ["a superadmin", [SUPERADMIN_PERMISSION, ...ANY_ADMIN_PERMISSION]],
  ])("passes the localized console href for %s, and nothing else", async (_who, permissions) => {
    state.permissions = permissions;
    const { switcher } = await brandBar("uk");
    // Only the string crosses into the client component: no grant list
    // (review #213) and no function prop.
    expect(switcher.props).toEqual({ locale: "uk", adminConsoleHref: "/uk/app/administrator" });
  });
});
