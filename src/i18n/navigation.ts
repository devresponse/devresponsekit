import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware navigation helpers.
 *
 * Always import `Link`, `redirect`, `usePathname`, and `useRouter` from this
 * module instead of `next/link` / `next/navigation` so navigation preserves
 * the active locale prefix and so middleware/proxy.ts handles redirects
 * correctly for localized routes.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
