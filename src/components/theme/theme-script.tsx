import { THEME_STORAGE_KEY } from "./theme-config";

/**
 * ThemeScript — the anti-flash (FOUC) theme initializer.
 *
 * The init logic: before the body paints, read the persisted theme (or the OS
 * preference for `"system"`) and stamp the matching class + `color-scheme` onto
 * `<html>`. The server renders `<html>` with no theme class (the choice is
 * per-user and unknowable on the server), so this runs first to avoid a flash;
 * `<html suppressHydrationWarning>` absorbs the resulting class mismatch.
 */
const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
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
