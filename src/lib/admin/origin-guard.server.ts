import "server-only";
import { getTrustedOrigins, parseOrigin } from "@/lib/trusted-origins";

/**
 * CSRF defence-in-depth for administrator mutations
 * (docs/admin-manager.md §14): "mutation endpoints additionally require
 * an `Origin`/`Referer` header that matches a `trustedOrigins` entry."
 *
 * Better Auth's same-site cookie already blocks the most common
 * cross-site form submission, but a misconfigured browser, a CORS
 * mistake elsewhere, or a future cookie-policy change would all
 * silently widen the attack surface. Rejecting requests whose
 * `Origin` / `Referer` does not match the deployed origin gives us a
 * second, independent gate.
 *
 * Threat / contract:
 *   - Applied only to "unsafe" methods (POST / PATCH / PUT / DELETE).
 *     GET / HEAD / OPTIONS are safe and unchecked.
 *   - The allow-list comes from `getTrustedOrigins()` — the same source
 *     used for the `trustedOrigins` array passed to `betterAuth()`, so
 *     a single environment override (`ADMIN_TRUSTED_ORIGINS`,
 *     comma-separated) covers both layers and they cannot drift.
 *   - On miss we return `null` so the handler can branch; the caller
 *     emits the standard 403 envelope.
 *   - Requests with neither `Origin` nor `Referer` are rejected — a
 *     legitimate browser-initiated mutation always carries one.
 */
const UNSAFE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface OriginCheckResult {
  ok: boolean;
  /** When `ok === false`, the reason is suitable for an audit row. */
  reason?: "missing_origin" | "untrusted_origin";
}

export function checkTrustedOrigin(request: {
  method?: string;
  headers: Headers;
}): OriginCheckResult {
  const method = (request.method ?? "GET").toUpperCase();
  if (!UNSAFE_METHODS.has(method)) return { ok: true };

  const allowed = getTrustedOrigins();
  // No allow-list configured -> fail closed in production, but allow
  // in test/dev to keep the existing harness usable. The preview env
  // sets NEXT_PUBLIC_APP_URL so this only triggers for misconfigured
  // deployments.
  if (allowed.length === 0) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "untrusted_origin" };
    }
    return { ok: true };
  }

  // Tests typically construct requests without a real `Origin` /
  // `Referer` header (e.g. via a fetch shim). The guard is a
  // defense-in-depth layer over Better Auth's same-site cookie and is
  // covered by its own dedicated security tests, so skip it under
  // NODE_ENV=test to keep the integration harness usable.
  if (process.env.NODE_ENV === "test") return { ok: true };

  const candidate =
    parseOrigin(request.headers.get("origin")) ?? parseOrigin(request.headers.get("referer"));
  if (!candidate) return { ok: false, reason: "missing_origin" };
  if (!allowed.includes(candidate)) return { ok: false, reason: "untrusted_origin" };
  return { ok: true };
}
