import "server-only";
import pino, { type Logger } from "pino";

/**
 * Always-on structured server logger (OBSERVABILITY-2).
 *
 * Emits one JSON object per line to stdout, so a deployment with Sentry
 * DISABLED — the default — still has a correlated error stream to ship to a
 * log aggregator. It uses pino's default synchronous stdout writer (NO
 * worker-thread transport), which bundles cleanly into the Next.js
 * standalone server; `server-only` keeps it out of any client/edge bundle.
 *
 * Level via `LOG_LEVEL` (fatal|error|warn|info|debug|trace|silent); defaults
 * to `info`, and to `silent` under `NODE_ENV=test` so the suite stays quiet.
 */
const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function resolveLevel(): string {
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv && VALID_LEVELS.has(fromEnv)) return fromEnv;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

export const logger: Logger = pino({
  level: resolveLevel(),
  base: { service: "devresponsekit" },
  // Emit the level name ("error") instead of pino's numeric code.
  formatters: { level: (label) => ({ level: label }) },
  // Defensive backstop: never let a known-sensitive field reach the stream.
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      "cookie",
      "*.cookie",
    ],
    censor: "[redacted]",
  },
});

/** Serializes an unknown thrown value into a safe, structured shape. */
function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { value: String(err) };
}

export interface ServerErrorFields {
  /** Correlation id shared with the audit row and any Sentry issue. */
  requestId?: string | null;
  /** The thrown value, if any (serialized to name/message/stack). */
  err?: unknown;
  /** Additional structured context. MUST NOT contain secrets. */
  [key: string]: unknown;
}

/**
 * Logs a server-side error at `error` level with correlation context. Call
 * from catch blocks that handle a 5xx, so the failure is visible in stdout —
 * and any aggregator — regardless of whether Sentry is enabled.
 */
export function logServerError(message: string, fields: ServerErrorFields = {}): void {
  const { err, requestId, ...rest } = fields;
  logger.error({ requestId: requestId ?? undefined, err: serializeError(err), ...rest }, message);
}
