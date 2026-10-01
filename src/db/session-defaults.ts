/**
 * The per-session ceilings every runtime connection runs under, in one place
 * (DEP3).
 *
 * Two paths deliver them. On a direct endpoint the runtime pool sends them as
 * startup parameters (`src/db/database.ts`, defaults for
 * `PG_STATEMENT_TIMEOUT_MS` / `PG_IDLE_IN_TX_TIMEOUT_MS`, also the env
 * schema's defaults in `src/lib/env.ts`). Behind a transaction pooler, where
 * startup parameters are refused, they are role defaults on the runtime login
 * (`LOGIN_ROLE_DEFAULTS` in `src/db/runtime-privileges.ts`, which `pnpm
 * db:runtime-login` sets). Both read these constants, so the two paths cannot
 * drift apart.
 *
 * Pure constants, no `server-only`: tsx scripts, the env schema and the
 * runtime pool all import it.
 */

/** Default `statement_timeout`, in milliseconds. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/** Default `idle_in_transaction_session_timeout`, in milliseconds. */
export const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 30_000;
