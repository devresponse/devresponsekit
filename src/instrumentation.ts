import * as Sentry from "@sentry/nextjs";
import {
  REQUEST_ID_HEADER,
  headerValueFromRecord,
  normalizeInboundRequestId,
} from "@/lib/request-id";

/**
 * Next.js server instrumentation entry point.
 *
 * `register()` loads the runtime-appropriate Sentry config (Node vs.
 * Edge). Both configs are opt-in no-ops without a DSN, so this is safe to
 * always run.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // OPS-4 / review #24: arm the SIGTERM/SIGINT watchdog. Next's own cleanup
    // drains HTTP and exits 143/130; the watchdog only ends the pg pool and
    // exits if that drain overruns SHUTDOWN_TIMEOUT_MS. Skipped during the
    // production *build* phase (no live pool) and confined to the Node
    // runtime — the shutdown module imports `pg`, which the edge runtime
    // cannot load. A no-op on Vercel (see the module).
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      // F-26: validate the whole env schema now, once per process. It used to
      // be parsed lazily, at the first import of a module that reads it
      // (auth.ts, on the first authenticated request), so an instance with an
      // invalid variable started, passed liveness and readiness, and then
      // answered 500 on every page that touched auth, while the docs said it
      // "fails fast at boot". Allowed to throw, like the key import below:
      // `next start` exits and a serverless function fails every request. The
      // error names each key and its rule, never a value. Imported here, not
      // statically, to keep the Edge graph as it is.
      const { getServerEnv } = await import("@/lib/env");
      getServerEnv();
      // F-22: import the Ed25519 signing keys and check each `x` against its
      // `d`, which the env schema cannot do (it is in the Edge graph, where
      // node:crypto is unavailable). Allowed to throw: Next fails startup
      // with "An error occurred while loading instrumentation hook". It runs
      // before the handlers below, so no process-level handler is installed
      // yet that could log the failure and carry on. Imported here, not
      // statically, so node:crypto stays out of the Edge bundle.
      const { assertSigningKeysImport } = await import("@/lib/env-signing-keys.server");
      assertSigningKeysImport();
      const { registerGracefulShutdown } = await import("@/lib/shutdown.server");
      registerGracefulShutdown();
      // D5 / review #23: log + capture stray unhandledRejection /
      // uncaughtException to Sentry (otherwise they are invisible). They do
      // not exit — Next treats both as non-fatal — unless
      // PROCESS_FATAL_ON_UNCAUGHT=1 opts uncaught exceptions into exit(1).
      const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
      registerProcessErrorHandlers();
      // F-17: one warning when a self-hosted production deployment has not
      // declared CLIENT_IP_SOURCE, because the default trusts X-Forwarded-For
      // and only the operator knows whether the edge overwrites it. Imported
      // here, not statically: it pulls in the pino logger.
      const { warnIfClientIpSourceUndeclared } =
        await import("@/lib/client-ip-source-warning.server");
      warnIfClientIpSourceUndeclared();
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * App Router server-error hook (RSC, route handlers, server actions).
 *
 * We stamp the request's `x-request-id` onto the captured event as a tag
 * so the Sentry issue and the stdout line below carry the same correlation
 * id as the `app_audit_events.request_id` rows written by `auditEvent`, rather
 * than a parallel one.
 *
 * F-29: this hook no longer sees a throw from an admin, first-party or v1
 * route handler. Those are exported through `withAdminRoute` / `withV1Route`
 * (`lib/route-handler.server.ts`), which catch the throw and answer a
 * `500 internal_error` envelope logged as `admin.internal_error` /
 * `v1.internal_error` under the id the response header and the audit rows
 * carry. What still arrives here (a page or server-component render, a
 * server action, an exempt route) was never given a minted id: the handler's
 * id is memoised on its own request object, which this hook cannot reach, so
 * the only id it can know is an inbound one it honours below. That id matches
 * the audit rows too, because `getOrCreateRequestId` honours the same header by
 * the same rule. Without one, the line and the event carry no request id.
 *
 * Review #99: this hook used to tag Sentry and stdout with the RAW inbound
 * header — no UUID check, no provenance check — while every other producer
 * ran it through the admin helper's validation. So the ONE id that reached
 * the error sinks was the one a client could choose: a forged value split the
 * correlation it exists to provide, and a malformed one (control characters,
 * markup, kilobytes of junk) went straight into a log line and a Sentry tag.
 * It now goes through the shared {@link normalizeInboundRequestId}, so a
 * malformed id yields NO tag rather than a poisoned one, and this hook and the
 * admin helper answer "which inbound ids do we honour" identically instead of
 * disagreeing. A well-formed FORGED id is still honoured here exactly as it is
 * everywhere else — that gap is #224's and is documented on the normaliser.
 *
 * The tag is set inside `Sentry.withScope` so it applies to THIS capture only
 * — `getCurrentScope()` mutated the scope the whole request shares, which on
 * a runtime that reuses an isolation scope let one request's id linger on a
 * later event.
 */
export const onRequestError = async (
  ...args: Parameters<typeof Sentry.captureRequestError>
): Promise<void> => {
  const [error, request] = args;
  const requestId = normalizeInboundRequestId(
    headerValueFromRecord(request.headers, REQUEST_ID_HEADER),
    headerValueFromRecord(request.headers, "x-forwarded-for"),
  );
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("request_id", requestId);
    Sentry.captureRequestError(...args);
  });

  // OPS-OBS-1: also write the uncaught error to the always-on stdout stream so a
  // default (no-DSN) deploy isn't blind to its own 500s. The logger pulls in
  // pino (node-only) and is `server-only`, while this hook also fires in the
  // edge runtime — so guard on the runtime and import lazily, mirroring
  // `register()`. Logging must never mask the original error.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("route.unhandled_error", { requestId, err: error });
    } catch {
      /* swallow — observability must not throw out of the error hook */
    }
  }
};
