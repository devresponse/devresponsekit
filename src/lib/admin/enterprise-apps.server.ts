import "server-only";

/**
 * Server-only re-export shim for the enterprise-apps validators
 * (docs/admin-manager.md §8.10, Phase 6).
 *
 * The actual rules live in `./enterprise-apps` so the client form
 * bundles can consume them. Server modules import from here so the
 * `server-only` guard still applies to anything that pulls in this
 * file from a server context.
 */
import { isHttpsOrigin } from "./enterprise-apps";

export {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
  type AppStatus,
} from "./enterprise-apps";

/**
 * Trusted host suffixes an enterprise-app `origin` may use (P2-5).
 *
 * `/api/sso/launch` mints a signed handoff token (carrying email, roles,
 * org) and redirects it to `app.origin`. Without an allow-list, any
 * `admin.apps.manage` holder could register an app whose origin they
 * control and harvest those tokens. We confine registrable origins to a
 * configured set of host suffixes.
 *
 * Source: `SSO_ALLOWED_ORIGIN_SUFFIXES` (comma-separated hosts, e.g.
 * `devresponse.com,partner.example`). When unset, falls back to the
 * registrable-ish parent of `NEXT_PUBLIC_PRODUCTION_HOST` (its last two
 * labels) so a single-domain deployment is safe by default. Multi-part
 * TLDs (`co.uk`) MUST set the env explicitly.
 */
export function allowedOriginSuffixes(): string[] {
  const raw = process.env.SSO_ALLOWED_ORIGIN_SUFFIXES;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^\.+/, "").toLowerCase())
      .filter(Boolean);
  }
  const host = process.env.NEXT_PUBLIC_PRODUCTION_HOST?.trim().toLowerCase();
  if (host) {
    const labels = host.split(".").filter(Boolean);
    if (labels.length >= 2) return [labels.slice(-2).join(".")];
    if (labels.length === 1) return [labels[0]!];
  }
  return [];
}

/**
 * True when `origin` is a valid HTTPS origin AND its host falls within the
 * allow-list. **Fails closed** when nothing is configured — register no
 * app rather than trust an arbitrary origin.
 */
export function isAllowedEnterpriseOrigin(origin: string): boolean {
  if (!isHttpsOrigin(origin)) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const suffixes = allowedOriginSuffixes();
  if (suffixes.length === 0) return false;
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}
