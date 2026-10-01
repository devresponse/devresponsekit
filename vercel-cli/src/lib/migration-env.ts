import { devNull } from "node:os";

/**
 * What the kit's migration runners are handed (`applyMigrations` in
 * `kit.ts`), as pure functions of the shell they are layered over.
 *
 * A module of its own, importing nothing of the CLI's, so that the kit's suite
 * can import it and hold the auth runner's placeholders to the kit's own env
 * schema (F-141): `kit.ts` reaches the spawn machinery, which does not compile
 * under the kit's tsconfig. The shell is typed as a plain record for the same
 * reason (Next types the kit's `process.env` with a required NODE_ENV).
 */

type Shell = Readonly<Record<string, string | undefined>>;

/**
 * The libpq variables `pg` falls back to for any part a connection string
 * leaves out: a URL with no port connects to PGPORT, one with no database to
 * PGDATABASE, and so on.
 */
const LIBPQ_TARGET_FALLBACKS = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER"];

/**
 * `names`, and every other spelling of them `inherited` holds, mapped to
 * `undefined`: layered over a child's environment, that drops them from it
 * however the shell spelled them. Names are matched case-insensitively,
 * because on Windows `pgport` IS `PGPORT` to the child.
 */
function unset(names: readonly string[], inherited: Shell): Record<string, undefined> {
  const spelled = Object.keys(inherited).filter((key) => names.includes(key.toUpperCase()));
  return Object.fromEntries([...names, ...spelled].map((key) => [key, undefined]));
}

/**
 * What the migration runners are handed, layered over the shell's
 * environment less the Vercel token (F-139): the URL and the schema, with
 * every libpq fallback that could pick a different server removed (an
 * `undefined` value drops the variable from the child).
 *
 * The URL was checked against production from what it says alone (F-47):
 * no port is 5432, no database is the user's name. A shell's PGPORT=5433 would
 * otherwise send a portless URL to a server the check never saw.
 */
export function migrationEnv(
  databaseUrl: string,
  schema: string,
  inherited: Shell = process.env,
): Record<string, string | undefined> {
  return {
    ...unset(LIBPQ_TARGET_FALLBACKS, inherited),
    DATABASE_URL: databaseUrl,
    DB_SCHEMA: schema,
  };
}

/**
 * The server variables the kit's env schema requires and cannot default,
 * DATABASE_URL aside, as the CI-only placeholders migrate-production.yml and
 * ci.yml give `db:auth:migrate` (F-141).
 *
 * The auth runner imports `@/lib/auth` for its OPTIONS (tables, plugins,
 * fields), and that import validates the whole server environment. None of
 * these values shapes the schema: the kit generates its committed snapshot
 * (better-auth-schema.sql) under the same placeholders, and CI fails when it
 * drifts. None reaches the database either. The kit's suite holds this list to
 * its schema (tests/unit/drk-deploy-auth-migration-env.test.ts).
 */
export const AUTH_MIGRATION_PLACEHOLDERS: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: "ci-only-better-auth-secret-not-for-production",
  BETTER_AUTH_URL: "http://localhost:3000",
  SSO_HANDOFF_ISSUER: "http://localhost:3000",
  SSO_HANDOFF_AUDIENCE_PREFIX: "devresponse-app",
  SSO_HANDOFF_APPLICATION_ID: "portal",
};

/**
 * The optional variables the kit's env schema checks against BETTER_AUTH_URL:
 * COOKIE_DOMAIN must cover its host, and API_JWT_ISSUER must equal it when
 * MCP_ENABLED. Neither shapes the Better Auth schema (`@/lib/auth` reads
 * COOKIE_DOMAIN for a cookie option, API_JWT_ISSUER not at all).
 */
const CHECKED_AGAINST_AUTH_URL = ["COOKIE_DOMAIN", "API_JWT_ISSUER"];

/** The names dotenv reads the file to load from: DOTENV_PATH first (dotenv 18), then DOTENV_CONFIG_PATH. */
const DOTENV_FILE_OPTIONS = ["DOTENV_PATH", "DOTENV_CONFIG_PATH"];

/**
 * What `db:auth:migrate` is handed (F-141): {@link migrationEnv}, a
 * placeholder for each of {@link AUTH_MIGRATION_PLACEHOLDERS} the shell does
 * not set, and no `.env` file.
 *
 * It used to get the URL and the schema alone, so the environment its import
 * validates came from the shell or from the kit checkout's `.env`, which the
 * runner loads through `dotenv/config`. The README's CI job has neither, and
 * failed every run with "Invalid server environment variables:
 * BETTER_AUTH_SECRET, ..."; on an operator's machine a stale `.env` (a
 * malformed SSO_HANDOFF_PRIVATE_KEY) failed production's migrations for a
 * reason that has nothing to do with production. So dotenv is pointed at the
 * null device, and production's migrations no longer depend on a developer's
 * file. The placeholders could not be mixed with that file anyway: a
 * COOKIE_DOMAIN in it does not cover the placeholder BETTER_AUTH_URL, and the
 * kit refuses that.
 *
 * A value the shell sets is kept, and validated as before: a placeholder never
 * replaces one, so a shell holding a real BETTER_AUTH_URL and COOKIE_DOMAIN
 * stays consistent. An empty one counts as unset, as it does everywhere in
 * this CLI: a CI step exporting a secret that is not defined exports "".
 * The one set value not kept is {@link CHECKED_AGAINST_AUTH_URL}: when
 * BETTER_AUTH_URL is the placeholder, the shell's COOKIE_DOMAIN and
 * API_JWT_ISSUER are left out too, because a real one is checked against that
 * URL and could only fail next to a placeholder.
 */
export function authMigrationEnv(
  databaseUrl: string,
  schema: string,
  inherited: Shell = process.env,
): Record<string, string | undefined> {
  const missing = Object.entries(AUTH_MIGRATION_PLACEHOLDERS).filter(([key]) => !inherited[key]);
  return {
    ...migrationEnv(databaseUrl, schema, inherited),
    ...(inherited.BETTER_AUTH_URL ? {} : unset(CHECKED_AGAINST_AUTH_URL, inherited)),
    ...unset(DOTENV_FILE_OPTIONS, inherited),
    DOTENV_CONFIG_PATH: devNull,
    // Otherwise dotenv prints "injected env (0)" and the null device's path.
    DOTENV_CONFIG_QUIET: "true",
    ...Object.fromEntries(missing),
  };
}
