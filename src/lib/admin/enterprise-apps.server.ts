import "server-only";

/**
 * Server-only re-export shim for the enterprise-apps validators
 * (docs/admin-manager.md §8.7).
 *
 * The actual rules live in `./enterprise-apps` so the client form
 * bundles can consume them. Server modules import from here so the
 * `server-only` guard still applies to anything that pulls in this
 * file from a server context.
 */
import { logger } from "@/lib/observability/logger.server";
import { isHttpsOrigin } from "./enterprise-apps";
import { checkOriginSuffix, registrableDomainOf, splitOriginSuffixList } from "./origin-suffixes";

export {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
  isOrgNamespacedAppId,
  isOrgNamespacedAudience,
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
 * `devresponse.com,partner.example`). Every entry must be a registrable
 * domain — a bare TLD or public-suffix entry (`com`, `co.uk`, `github.io`)
 * would let an org admin register an origin anyone can obtain under it, so
 * such entries are refused at boot (`src/lib/env.ts`) and, as defence in
 * depth, ignored here (review #14).
 *
 * Unset: **production fails closed** (no suffix ⇒ no registrable origin) and
 * logs a warning once — the previous last-two-labels fallback turned a
 * multi-part-TLD host (`app.example.co.uk`) into the bare public suffix
 * `co.uk`. Outside production the list is still derived from
 * `NEXT_PUBLIC_PRODUCTION_HOST`, now as its PSL registrable domain
 * (`app.example.co.uk` ⇒ `example.co.uk`) or `localhost`.
 */
export function allowedOriginSuffixes(): string[] {
  const production = process.env.NODE_ENV === "production";
  const options = { allowLocalhost: !production };
  const entries = splitOriginSuffixList(process.env.SSO_ALLOWED_ORIGIN_SUFFIXES);
  if (entries.length > 0) {
    const rejected = entries.filter((s) => !checkOriginSuffix(s, options).ok);
    if (rejected.length > 0) warnRejectedEntries(rejected);
    return entries.filter((s) => !rejected.includes(s));
  }
  if (production) {
    warnUnsetInProduction();
    return [];
  }
  const host = process.env.NEXT_PUBLIC_PRODUCTION_HOST;
  const derived = host ? registrableDomainOf(host) : null;
  if (derived && checkOriginSuffix(derived, options).ok) return [derived];
  return [];
}

let warnedUnset = false;
let warnedRejected: string | null = null;

/** Once per process: production has no allow-list, so registration is off. */
function warnUnsetInProduction(): void {
  if (warnedUnset) return;
  warnedUnset = true;
  logger.warn(
    "SSO_ALLOWED_ORIGIN_SUFFIXES is unset in production: enterprise-app origins cannot be registered (fails closed). Set it to the registrable domain(s) satellites live under, e.g. devresponse.com",
  );
}

/** Once per distinct set: entries the boot check should already have refused. */
function warnRejectedEntries(rejected: string[]): void {
  const key = rejected.join(",");
  if (warnedRejected === key) return;
  warnedRejected = key;
  logger.warn(
    { rejected },
    "SSO_ALLOWED_ORIGIN_SUFFIXES contains entries that are not registrable domains (bare TLD / public suffix); they are ignored",
  );
}

/**
 * True when `origin` is a valid HTTPS origin AND its host falls within the
 * allow-list. **Fails closed** when nothing is configured — register no
 * app rather than trust an arbitrary origin.
 *
 * This deployment's own origin (`BETTER_AUTH_URL`) is never a target, even
 * under an allowed suffix (F-83): the catalog lists applications this
 * deployment hands users OFF to, and the primary is not one of them.
 */
export function isAllowedEnterpriseOrigin(origin: string): boolean {
  if (!isHttpsOrigin(origin)) return false;
  let host: string;
  let parsed: string;
  try {
    const url = new URL(origin);
    host = url.hostname.toLowerCase();
    parsed = url.origin;
  } catch {
    return false;
  }
  if (parsed === ownOrigin()) return false;
  const suffixes = allowedOriginSuffixes();
  if (suffixes.length === 0) return false;
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

/** This deployment's own origin, from `BETTER_AUTH_URL`, or null when unusable. */
function ownOrigin(): string | null {
  try {
    const url = new URL(process.env.BETTER_AUTH_URL ?? "");
    // Any other scheme's `origin` is the STRING "null" (F-22).
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * True when `id` is this deployment's own `SSO_HANDOFF_APPLICATION_ID` (F-83).
 *
 * The consume route accepts a handoff whose `targetApplicationId` is that id
 * and whose audience is `<prefix>:<id>`, so a catalog row carrying both makes
 * this deployment a target of itself: any member can launch it for a fresh
 * session past the absolute-lifetime cap, or send a victim a consume link
 * that swaps their session for the sender's account (login CSRF behind one
 * click). Registration refuses the id here, and the audience in
 * `isSsoAudienceTaken`; the id cannot change after creation.
 */
export function isOwnSsoApplicationId(id: string): boolean {
  const own = process.env.SSO_HANDOFF_APPLICATION_ID;
  return Boolean(own) && id === own;
}
