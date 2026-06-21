import { THEME_STORAGE_KEY } from "./theme-config";

/**
 * ThemeScript — the anti-flash (FOUC) theme initializer.
 *
 * A blocking inline script that, before the body paints, reads the persisted
 * theme (or the OS preference for `"system"`) and stamps the matching class +
 * `color-scheme` onto `<html>`. The server renders `<html>` with no theme class
 * (the choice is per-user and unknowable on the server), so this runs first to
 * avoid a flash; `<html suppressHydrationWarning>` absorbs the resulting class
 * mismatch.
 *
 * Rendered from a SERVER component (and emitted into the SSR HTML), so React
 * hydrates it in place. React 19 warns about inline `<script>` elements that
 * are *created on the client* — which is exactly what tripped `next-themes`,
 * whose anti-flash script is rendered from a client provider. A server-rendered,
 * hydrated script does not hit that path.
 *
 * Carries the per-request CSP `nonce` so it survives the enforcing policy.
 */
const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})||"system",t=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p,e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t);e.style.colorScheme=t}catch(e){}})();`;

export function ThemeScript({ nonce }: { nonce?: string }) {
  // `suppressHydrationWarning`: browsers clear a script's `nonce` content
  // attribute from the DOM after load (a CSP anti-exfiltration measure), so by
  // the time React hydrates, the DOM's nonce reads "" while React's tree still
  // carries the real value — a benign attribute-only mismatch React would
  // otherwise flag. The script has already executed during HTML parse (with a
  // valid nonce under the enforcing CSP), so its post-load nonce is moot.
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
    />
  );
}
