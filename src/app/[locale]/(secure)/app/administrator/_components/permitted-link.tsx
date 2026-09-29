import type { ComponentProps } from "react";
import { LocaleLink } from "@/components/i18n/locale-link";

/**
 * A cross-link from one administrator page to another, rendered as a link only
 * when the viewer passes the DESTINATION page's guard (F-67).
 *
 * A grid on one page names records another page owns: a member's email, a key
 * owner, a role, an organization. The host page checks its own permission, not
 * the destination's, so a viewer holding only the host's could click through
 * to a 404 that also wrote an `administrator.access.denied` row, which reads
 * like probing in the audit explorer. The name is still worth showing, so
 * without the permission it renders as plain text. `permitted` is a boolean
 * the server page derives from `guard.access.permissions` with the
 * destination page's own guard key.
 */
export function PermittedLink({
  permitted,
  ...link
}: ComponentProps<typeof LocaleLink> & { permitted: boolean }) {
  return permitted ? <LocaleLink {...link} /> : <>{link.children}</>;
}
