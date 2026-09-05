import { parse } from "tldts";

/**
 * Validation for the `SSO_ALLOWED_ORIGIN_SUFFIXES` allow-list (review #14).
 *
 * Every entry confines the `origin` an `admin.apps.manage` holder may register
 * for an enterprise app — and that origin is where `/api/sso/launch` sends a
 * signed handoff token carrying the user's identity. A suffix that is a bare
 * TLD (`com`) or a public-suffix entry (`co.uk`, `github.io`) therefore lets
 * an org admin register an origin ANYONE can obtain under that suffix and
 * harvest tokens. Each entry must be a registrable domain: at least one label
 * beyond the public suffix, as computed by `tldts` against the Public Suffix
 * List (ICANN + PRIVATE sections, so `github.io`-style hosting providers are
 * treated as public too).
 *
 * This module is deliberately free of `server-only` so `src/lib/env.ts`
 * (importable from `tsx` scripts) can validate the list at boot.
 */

/** RFC 1123 hostname: lowercase labels of 1–63 chars, 253 chars total. */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const LOCALHOST = "localhost";

export interface OriginSuffixOptions {
  /**
   * Accept the literal `localhost` (RFC 6761 loopback, never a public suffix
   * but also not a registrable domain). Only sensible outside production —
   * the local satellite rig lists it (docs/integration-satellite-apps.md §6.6).
   */
  allowLocalhost?: boolean;
}

export type OriginSuffixVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_hostname" | "ip_address" | "public_suffix" | "localhost_not_allowed";
    };

/** Trim, strip leading/trailing dots, lowercase. Does NOT validate. */
export function normalizeOriginSuffix(entry: string): string {
  return entry.trim().replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase();
}

/**
 * Splits the comma-separated env value into normalized, de-duplicated
 * entries (blank entries dropped). Unset / blank ⇒ `[]`.
 */
export function splitOriginSuffixList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = normalizeOriginSuffix(part);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Decides whether ONE normalized entry is safe to act as an origin suffix.
 *
 * Rejects anything that is not a plain hostname (schemes, ports, paths,
 * wildcards, underscores), IP literals, bare TLDs and public-suffix entries.
 * An unknown TLD (`devresponse.local`, `example.internal`) is treated by the
 * PSL as a one-label suffix, so `devresponse.local` passes and `local` fails —
 * the right outcome for a private dev rig.
 */
export function checkOriginSuffix(
  suffix: string,
  options: OriginSuffixOptions = {},
): OriginSuffixVerdict {
  if (!HOSTNAME_RE.test(suffix)) return { ok: false, reason: "invalid_hostname" };
  if (suffix === LOCALHOST) {
    return options.allowLocalhost ? { ok: true } : { ok: false, reason: "localhost_not_allowed" };
  }
  const lastLabel = suffix.slice(suffix.lastIndexOf(".") + 1);
  // No TLD is all-digits; an entry such as `0.1` would otherwise match the
  // IP literal `10.0.0.1` via the `endsWith(".0.1")` host check.
  if (/^\d+$/.test(lastLabel)) return { ok: false, reason: "ip_address" };
  const parsed = parse(suffix, { allowPrivateDomains: true });
  if (parsed.isIp) return { ok: false, reason: "ip_address" };
  // tldts tolerates URL-ish input (`https://x/`, `host:port`) by extracting the
  // hostname; the regex above already excludes those, but pin it anyway.
  if (parsed.hostname !== suffix) return { ok: false, reason: "invalid_hostname" };
  if (!parsed.domain) return { ok: false, reason: "public_suffix" };
  return { ok: true };
}

/**
 * The entries of `raw` that fail {@link checkOriginSuffix}. Empty ⇒ the whole
 * list is acceptable (an unset / blank list is trivially acceptable here —
 * whether "unset" is *safe* is the caller's decision, see
 * `allowedOriginSuffixes()`).
 */
export function invalidOriginSuffixes(
  raw: string | undefined,
  options: OriginSuffixOptions = {},
): string[] {
  return splitOriginSuffixList(raw).filter((s) => !checkOriginSuffix(s, options).ok);
}

/**
 * The registrable domain of a deployment host (`app.example.co.uk` ⇒
 * `example.co.uk`, `app.devresponse.com` ⇒ `devresponse.com`), or `localhost`
 * for a loopback host. `null` when the host has no registrable parent (an IP
 * literal, a bare public suffix, garbage). Used ONLY for the non-production
 * fallback that derives the allow-list from `NEXT_PUBLIC_PRODUCTION_HOST`.
 */
export function registrableDomainOf(host: string): string | null {
  const normalized = normalizeOriginSuffix(host);
  if (!normalized) return null;
  const parsed = parse(normalized, { allowPrivateDomains: true });
  if (parsed.isIp) return null;
  if (parsed.domain) return parsed.domain;
  return parsed.hostname === LOCALHOST ? LOCALHOST : null;
}
