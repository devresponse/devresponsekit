import { getBrand } from "@/config/brand";

/**
 * BrandLogo — the single brand-mark slot (white-label Phase 0).
 *
 * Renders the active brand's wordmark. The Phase-0 `default` brand has no image
 * logo, so it renders as text: the full {@link getBrand} `name`, or `shortName`
 * when `compact` (matching the old secure-shell `<span>DevResponse</span>`).
 * `className` styles the text span; when omitted the span inherits typography
 * from its parent (e.g. a styled brand link), so existing markup is unchanged.
 *
 * Phase 1 adds image logos: when `Brand.logo.{light,dark}` is set this is where
 * they render (color-scheme aware via the theme). Until then it is text-only,
 * so the rendered output is identical to the literals it replaced.
 */
export function BrandLogo({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const brand = getBrand();
  return <span className={className}>{compact ? brand.shortName : brand.name}</span>;
}
