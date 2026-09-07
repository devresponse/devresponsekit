import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locales, type SupportedLocale } from "@/config/i18n-config";
import type * as NavServerModule from "@/lib/navigation.server";
import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import es from "@/messages/es.json";
import uk from "@/messages/uk.json";
import pt from "@/messages/pt.json";
import zh from "@/messages/zh.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";

/**
 * Menu-label locale completeness (review #135).
 *
 * `navigation.server.ts` builds shell/nested menu labels from its own
 * `MESSAGE_LOADERS` map rather than the request-scoped translator. That map
 * covered en/fr/es/uk only, so pt/zh/hi/ja readers got ENGLISH menu labels in
 * an otherwise fully localized shell — a silent half-fleet regression that
 * every other test passed straight through.
 *
 * Mirrors the guard pattern in `locale-message-parity.test.ts`: the expected
 * locale list is derived from `locales`, and the catalogs are imported
 * statically here, so adding a locale to `i18n-config.ts` fails this file
 * until the loader exists AND actually resolves that locale's strings.
 */
const enterpriseExecute = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({ execute: enterpriseExecute }),
          }),
        }),
      }),
    }),
  },
}));

const CATALOGS: Record<SupportedLocale, unknown> = { en, fr, es, uk, pt, zh, hi, ja };

const ACTIVE = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: ["shell.view"],
};

/** The `shell` label for a menu item id, read straight from the catalog. */
function shellLabel(locale: SupportedLocale, key: string): string {
  const shell = (CATALOGS[locale] as { shell: Record<string, string> }).shell;
  return shell[key]!;
}

let mod: typeof NavServerModule;

beforeEach(async () => {
  enterpriseExecute.mockReset();
  mod = await import("@/lib/navigation.server");
});
afterEach(() => vi.resetModules());

describe("shell menu labels are localized for EVERY supported locale (review #135)", () => {
  it("has a message loader for every locale in i18n-config (and no extras)", () => {
    expect([...mod.MENU_MESSAGE_LOCALES].sort()).toEqual([...locales].sort());
  });

  it("imports a catalog here for every supported locale", () => {
    // Static-import completeness guard, same reason as locale-message-parity:
    // a new locale is invisible to this file until someone imports its JSON.
    expect(Object.keys(CATALOGS).sort()).toEqual([...locales].sort());
  });

  it.each(locales.filter((l) => l !== "en"))(
    "%s shell menu labels come from the %s catalog, not English",
    async (locale) => {
      const res = await mod.loadShellMenu(ACTIVE, "primary-sidebar", locale);
      const dashboard = res.items.find((i) => i.id === "dashboard")!;
      const docs = res.items.find((i) => i.id === "documentation")!;

      expect(dashboard.label).toBe(shellLabel(locale, "dashboard"));
      expect(docs.label).toBe(shellLabel(locale, "documentation"));
      // The regression this pins: falling back to `en` would render the
      // English string for locales whose translation actually differs.
      if (shellLabel(locale, "dashboard") !== shellLabel("en", "dashboard")) {
        expect(dashboard.label).not.toBe(shellLabel("en", "dashboard"));
      }
    },
  );

  it.each(locales)("nested-app menu labels are localized for %s", async (locale) => {
    const res = await mod.loadNestedAppsMenu(ACTIVE, "portal", locale);
    expect(res.items[0]!.label).toBe(shellLabel(locale, "settings"));
  });

  it("still falls back to the default locale for an unsupported input", async () => {
    const res = await mod.loadShellMenu(ACTIVE, "primary-sidebar", "kl");
    expect(res.items.find((i) => i.id === "dashboard")!.label).toBe(shellLabel("en", "dashboard"));
  });
});
