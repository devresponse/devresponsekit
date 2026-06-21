import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import es from "@/messages/es.json";
import uk from "@/messages/uk.json";
import pt from "@/messages/pt.json";

/**
 * Locale message-parity guard (a11y-6).
 *
 * next-intl loads each locale's file as-is with no per-key fallback, so a
 * key present in `en` but missing/renamed in another locale renders the raw
 * key path — or, for the landing page's `t.raw("public.*.items")` array
 * casts, makes `t.raw()` return the key STRING, so `.map(...)` throws and
 * crashes the whole localized home page (a11y-5). This test converts that
 * latent runtime/UX regression into a CI failure: every locale must have
 * exactly the same set of message key-paths as `en`, and the landing
 * `public.*.items` arrays must share `en`'s length.
 */

/** Every leaf key-path in a message tree (recursing into array items by index). */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

/** Length of `public.<group>.items`, or -1 if absent/not an array. */
function itemsLength(messages: unknown, group: string): number {
  const pub = (messages as { public?: Record<string, { items?: unknown[] }> }).public;
  const items = pub?.[group]?.items;
  return Array.isArray(items) ? items.length : -1;
}

const LOCALES: Array<[string, unknown]> = [
  ["fr", fr],
  ["es", es],
  ["uk", uk],
  ["pt", pt],
];
const ITEM_GROUPS = ["stats", "features", "why", "stack"] as const;

describe("locale message parity (vs en)", () => {
  const enPaths = leafPaths(en).sort();

  it.each(LOCALES)("%s has exactly the same key-paths as en", (name, messages) => {
    const paths = leafPaths(messages).sort();
    const missing = enPaths.filter((p) => !paths.includes(p));
    const extra = paths.filter((p) => !enPaths.includes(p));
    // Compare with surrounding context so a failure names the exact drift.
    expect({ locale: name, missing, extra }).toEqual({ locale: name, missing: [], extra: [] });
  });

  it.each(LOCALES)("%s landing public.*.items arrays match en lengths", (name, messages) => {
    for (const group of ITEM_GROUPS) {
      expect(itemsLength(messages, group), `${name} public.${group}.items length`).toBe(
        itemsLength(en, group),
      );
    }
  });
});
