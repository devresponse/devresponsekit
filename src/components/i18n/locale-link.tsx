"use client";

import { Link as IntlLink } from "@/i18n/navigation";
import type { ComponentProps } from "react";

/**
 * LocaleLink
 *
 * Wrapper around the `next-intl` Link that always preserves the active
 * locale prefix. Use this for all in-app browser routes; for API routes
 * use a normal anchor tag with the absolute path.
 */
export function LocaleLink(props: ComponentProps<typeof IntlLink>) {
  return <IntlLink {...props} />;
}
