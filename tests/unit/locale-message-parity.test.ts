import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import es from "@/messages/es.json";
import uk from "@/messages/uk.json";
import pt from "@/messages/pt.json";
import zh from "@/messages/zh.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import { defaultLocale, locales } from "@/config/i18n-config";

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

/** key-path -> leaf value, for the whole tree. */
function leafValues(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => leafValues(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) leafValues(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = value;
  return out;
}

/**
 * Every ICU ARGUMENT NAME referenced by a message, sorted.
 *
 * Key-path parity alone does not catch a translation that dropped a
 * placeholder: `"Revoke session {session}"` translated as `"Révoquer la
 * session"` keeps the key, passes the parity check above, and silently
 * renders an accessible name with no row identity in it (review #106).
 *
 * Hand-rolled rather than pulled from `@formatjs/icu-messageformat-parser`
 * (a transitive of next-intl, not a declared dependency): a full ICU parse
 * is not needed, only the argument names. The one subtlety is that a
 * plural/select OPTION body is itself a message — `{count, plural, =0 {No
 * members} other {# members}}` must yield `count`, not `No` — so option
 * bodies are recursed into as messages, never read as arguments.
 */
function icuArguments(message: unknown): string[] {
  if (typeof message !== "string") return [];
  const names = new Set<string>();
  readMessage(message, 0, names);
  return [...names].sort();
}

/** Reads a message body; returns the index of its terminating `}` or EOF. */
function readMessage(src: string, start: number, names: Set<string>): number {
  let i = start;
  while (i < src.length) {
    if (src[i] === "}") return i;
    if (src[i] === "{") {
      i = readArgument(src, i + 1, names);
      continue;
    }
    i++;
  }
  return i;
}

/** Reads `<name>[, <type>[, <options>]]}`; returns the index after its `}`. */
function readArgument(src: string, start: number, names: Set<string>): number {
  let i = start;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const nameStart = i;
  while (i < src.length && !/[,}\s]/.test(src[i]!)) i++;
  if (i > nameStart) names.add(src.slice(nameStart, i));
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === "}") return i + 1;
  if (src[i] !== ",") return i; // malformed — stop rather than loop
  // Skip the type, then walk the option bodies as nested messages.
  while (i < src.length && src[i] !== "}") {
    if (src[i] === "{") {
      i = readMessage(src, i + 1, names) + 1;
      continue;
    }
    i++;
  }
  return i + 1;
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
  ["zh", zh],
  ["hi", hi],
  ["ja", ja],
];
const ITEM_GROUPS = ["stats", "features", "why", "stack"] as const;

describe("locale message parity (vs en)", () => {
  const enPaths = leafPaths(en).sort();

  // Completeness guard (review #110): the catalogs above are static imports,
  // so a locale added to `locales` in i18n-config.ts is invisible to this file
  // until someone imports its JSON here. Without this check a new locale ships
  // with a green suite and zero parity coverage.
  it("checks every non-default locale declared in i18n-config", () => {
    const declared = locales.filter((l) => l !== defaultLocale).sort();
    const covered = LOCALES.map(([name]) => name).sort();
    expect(covered).toEqual(declared);
  });

  it.each(LOCALES)("%s has exactly the same key-paths as en", (name, messages) => {
    const paths = leafPaths(messages).sort();
    const missing = enPaths.filter((p) => !paths.includes(p));
    const extra = paths.filter((p) => !enPaths.includes(p));
    // Compare with surrounding context so a failure names the exact drift.
    expect({ locale: name, missing, extra }).toEqual({ locale: name, missing: [], extra: [] });
  });

  // Review #106: the a11y strings added for the shell landmarks and the
  // per-row action buttons interpolate values ({session}, {name}, {max},
  // {brand}). A translation that drops one still passes the key-path check
  // above while rendering an accessible name with the identifying part
  // missing — exactly the defect those keys were added to fix.
  const enValues = leafValues(en);
  it.each(LOCALES)("%s uses the same ICU arguments as en in every message", (name, messages) => {
    const values = leafValues(messages);
    const drift = Object.keys(enValues)
      .filter((path) => path in values)
      .map((path) => ({
        path,
        en: icuArguments(enValues[path]),
        locale: icuArguments(values[path]),
      }))
      .filter((row) => row.en.join(",") !== row.locale.join(","));
    expect({ locale: name, drift }).toEqual({ locale: name, drift: [] });
  });

  it("extracts ICU argument names without mistaking plural option bodies for arguments", () => {
    // Self-check for the hand-rolled extractor above.
    expect(icuArguments("Expires {value}")).toEqual(["value"]);
    expect(icuArguments("{count, plural, =0 {No members} other {# members}}")).toEqual(["count"]);
    expect(icuArguments("{s, select, active {Active} other {Other}} — {name}")).toEqual([
      "name",
      "s",
    ]);
    expect(icuArguments("no placeholders here")).toEqual([]);
    expect(icuArguments(42)).toEqual([]);
  });

  it.each(LOCALES)("%s landing public.*.items arrays match en lengths", (name, messages) => {
    for (const group of ITEM_GROUPS) {
      expect(itemsLength(messages, group), `${name} public.${group}.items length`).toBe(
        itemsLength(en, group),
      );
    }
  });
});
