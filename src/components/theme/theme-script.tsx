import { THEME_STORAGE_KEY } from "./theme-config";

/**
 * A JavaScript string literal for `value` that is safe to place inside an
 * inline `<script>` element.
 *
 * `JSON.stringify` alone yields a valid JS literal but not a safe one here: the
 * HTML parser ends a script element at the first `</script`, before any JS
 * parsing, so a value containing it would close the element and run what follows
 * as markup (and `<!--` changes how the element is tokenized). Escaping `<` and
 * `>` as `\u003c`/`\u003e` leaves the string's value unchanged while no markup
 * can survive; U+2028/U+2029 are escaped too because pre-ES2019 engines treat
 * them as line terminators inside a string literal. Today's only input is the
 * constant storage key, so this makes the script's safety independent of that
 * constant rather than fixing a live injection (F-112, CodeQL
 * js/bad-code-sanitization).
 */
export function inlineScriptStringLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * ThemeScript — the anti-flash (FOUC) theme initializer.
 *
 * The init logic: before the body paints, read the persisted theme (or the OS
 * preference for `"system"`) and stamp the matching class + `color-scheme` onto
 * `<html>`. The server renders `<html>` with no theme class (the choice is
 * per-user and unknowable on the server), so this runs first to avoid a flash;
 * `<html suppressHydrationWarning>` absorbs the resulting class mismatch.
 */
const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${inlineScriptStringLiteral(
  THEME_STORAGE_KEY,
)})||"system",t=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p,e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t);e.style.colorScheme=t}catch(e){}})();`;

/**
 * Why the script is emitted as a wrapper's `innerHTML` rather than a React
 * `<script>` element:
 *
 * React 19 treats every `<script>` element as a hoistable resource and
 * RE-CREATES it on the client whenever its parent re-renders — and the
 * `[locale]` layout re-renders on every language switch. That trips React's
 * "Encountered a script tag while rendering React component… never executed
 * when rendering on the client" warning (it fired the same way for next-themes'
 * client-rendered script, and again when this was a server `<script>` element).
 *
 * A `<script>` inside `dangerouslySetInnerHTML` is opaque to React — it never
 * reconciles a `<script>` element, so the warning never fires. The browser
 * still parses + executes the script from the SSR HTML (the flash is still
 * prevented). It does NOT re-run on client navigation, which is correct: the
 * provider keeps `<html>` in sync after mount, so the init only matters on the
 * first server-rendered paint. (A `<template>` — React's own suggestion — won't
 * do: its contents are inert and never execute.)
 */
export function ThemeScript({ nonce }: { nonce?: string }) {
  // The nonce is a server-minted base64 CSP value; strip anything that isn't
  // base64url as defense-in-depth so it can never break out of the attribute.
  const safeNonce = nonce ? nonce.replace(/[^A-Za-z0-9+/=_-]/g, "") : "";
  const nonceAttr = safeNonce ? ` nonce="${safeNonce}"` : "";
  return (
    // `suppressHydrationWarning`: browsers clear a script's `nonce` content
    // attribute from the DOM after load (a CSP anti-exfiltration measure), so the
    // hydrated innerHTML differs from React's by that attribute only — benign.
    <div
      hidden
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: `<script${nonceAttr}>${THEME_INIT_SCRIPT}</script>` }}
    />
  );
}
