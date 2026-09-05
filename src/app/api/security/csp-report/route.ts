import { NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger.server";
import { rateLimitKey } from "@/lib/admin/rate-limit.server";
import { consumeSharedToken } from "@/lib/admin/rate-limit-shared.server";
import { clientIpKey } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

/**
 * POST /api/security/csp-report — Content-Security-Policy violation sink (A7).
 *
 * The app-wide CSP is **enforcing**, nonce-based, and minted per request in
 * `src/proxy.ts`; it keeps `report-uri` / `report-to` pointed here, so this is
 * the sink real blocks (and any regression after the cutover) report to —
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
 *
 * Flood control (P2-5): the sink is attacker-influenced and potentially
 * high-volume, so beyond the body cap it (1) applies a coarse per-IP + global
 * token-bucket floor before any work — consumed from the SHARED Postgres
 * bucket (review #98), because an in-memory floor on a per-lambda runtime
 * multiplied by the invocation count and was global in name only; when the
 * database is unreachable the floor falls back to the in-process bucket
 * with a warning rather than dropping or 5xx-ing reports — (2) processes at most
 * MAX_VIOLATIONS_PER_REQUEST entries from a batch (a `reports+json` array can
 * pack ~1.8k into 64 KiB), and (3) aggregates to ONE log line per effective
 * directive (with a count) instead of one per violation.
 */

/** A CSP report is < 2 KiB; anything larger is hostile bulk — drop it unread. */
const MAX_BODY_BYTES = 64 * 1024;
/** Bound a single URL/field so one report can't flood the log. */
const MAX_FIELD_LEN = 2048;
/** Process at most this many violations from one (possibly batched) request. */
const MAX_VIOLATIONS_PER_REQUEST = 20;
/** Coarse flood floors — generous for real reporting, hard cap on abuse. */
const CSP_GLOBAL_LIMIT = { capacity: 600, refillPerSec: 10 };
const CSP_IP_LIMIT = { capacity: 30, refillPerSec: 1 };

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
  // Flood floor FIRST (P2-5): cap request volume per IP + globally before any
  // parsing or logging. Always 204 so a throttled probe learns nothing.
  if (
    !(await consumeSharedToken(rateLimitKey("csp.report", "__global__"), CSP_GLOBAL_LIMIT)).ok ||
    !(
      await consumeSharedToken(
        rateLimitKey("csp.report", clientIpKey(request.headers)),
        CSP_IP_LIMIT,
      )
    ).ok
  ) {
    return noContent();
  }

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

  // Cap + aggregate (P2-5): collapse the (capped) batch to ONE line per
  // effective directive — with a count and a representative sample — so a
  // single request can't pump dozens of lines into the stream.
  const capped = violations.slice(0, MAX_VIOLATIONS_PER_REQUEST);
  const byDirective = new Map<string, { count: number; sample: NormalizedViolation }>();
  for (const violation of capped) {
    const key = violation.effectiveDirective ?? "unknown";
    const agg = byDirective.get(key);
    if (agg) agg.count += 1;
    else byDirective.set(key, { count: 1, sample: violation });
  }

  for (const [effectiveDirective, { count, sample }] of byDirective) {
    logger.warn(
      {
        kind: "csp-violation",
        effectiveDirective,
        count,
        disposition: sample.disposition ?? "report",
        userAgent,
        documentUri: sample.documentUri,
        blockedUri: sample.blockedUri,
        sourceFile: sample.sourceFile,
        lineNumber: sample.lineNumber,
        // Flag when the batch exceeded the per-request cap so a flood is visible.
        truncated: violations.length > capped.length ? violations.length : undefined,
      },
      "csp violation report (enforced)",
    );
  }

  return noContent();
}
