import { NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/security/csp-report — Content-Security-Policy violation sink (A7).
 *
 * The app-wide CSP ships in **Report-Only** mode (see `next.config.mjs`); this
 * endpoint is the sink the policy reports to, so violations are actually
 * collected instead of dropped on the floor. Each violation is written to the
 * structured logger at `warn` — which always ships to stdout (and any
 * aggregator) regardless of whether Sentry is enabled — rather than to the
 * database: reports are attacker-influenced and potentially high-volume, so a
 * log stream (with its own retention) is the right home, not an unbounded table.
 *
 * It accepts BOTH wire formats so coverage spans browsers:
 *   - legacy  `application/csp-report`    → `{ "csp-report": { "document-uri", … } }`
 *   - modern  `application/reports+json`  → `[{ "type": "csp-violation", "body": { … } }]`
 *
 * Hardening: unauthenticated by necessity (the Reporting API sends no cookies),
 * so it does the minimum work and leaks nothing — body size is capped, parse
 * failures are swallowed, individual fields are truncated, and it ALWAYS answers
 * `204` so a probe can't distinguish accepted from rejected input.
 */

/** A CSP report is < 2 KiB; anything larger is hostile bulk — drop it unread. */
const MAX_BODY_BYTES = 64 * 1024;
/** Bound a single URL/field so one report can't flood the log. */
const MAX_FIELD_LEN = 2048;

interface NormalizedViolation {
  documentUri?: string;
  effectiveDirective?: string;
  blockedUri?: string;
  sourceFile?: string;
  lineNumber?: number;
  disposition?: string;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…[truncated]` : value;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Legacy `application/csp-report` body (hyphenated keys). */
function fromLegacy(report: Record<string, unknown>): NormalizedViolation {
  return {
    documentUri: str(report["document-uri"]),
    // `violated-directive` is the older name; prefer `effective-directive`.
    effectiveDirective: str(report["effective-directive"] ?? report["violated-directive"]),
    blockedUri: str(report["blocked-uri"]),
    sourceFile: str(report["source-file"]),
    lineNumber: num(report["line-number"]),
    disposition: str(report["disposition"]),
  };
}

/** Reporting API `application/reports+json` entry body (camelCase keys). */
function fromReportingApi(body: Record<string, unknown>): NormalizedViolation {
  return {
    documentUri: str(body["documentURL"]),
    effectiveDirective: str(body["effectiveDirective"] ?? body["violatedDirective"]),
    blockedUri: str(body["blockedURL"]),
    sourceFile: str(body["sourceFile"]),
    lineNumber: num(body["lineNumber"]),
    disposition: str(body["disposition"]),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<NextResponse> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return noContent();
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return noContent();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return noContent();
  }

  const contentType = request.headers.get("content-type") ?? "";
  const userAgent = str(request.headers.get("user-agent") ?? undefined);
  const violations: NormalizedViolation[] = [];

  if (contentType.includes("application/reports+json") && Array.isArray(parsed)) {
    // The Reporting API batches reports; we only care about CSP ones.
    for (const entry of parsed) {
      if (isObject(entry) && entry["type"] === "csp-violation" && isObject(entry["body"])) {
        violations.push(fromReportingApi(entry["body"]));
      }
    }
  } else if (isObject(parsed) && isObject(parsed["csp-report"])) {
    violations.push(fromLegacy(parsed["csp-report"]));
  }

  for (const violation of violations) {
    logger.warn(
      {
        kind: "csp-violation",
        disposition: violation.disposition ?? "report",
        userAgent,
        ...violation,
      },
      "csp violation report (report-only)",
    );
  }

  return noContent();
}
