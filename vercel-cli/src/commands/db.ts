import { requireConfig, requireToken } from "../lib/config.js";
import { CliError, bold, dim, field, heading, info, ok, step, warn } from "../lib/log.js";
import { describeProfile, migrationPolicy, resolveProfile } from "../lib/target.js";
import { VercelClient } from "../lib/vercel-client.js";

/**
 * Postgres provisioning through the Vercel Marketplace.
 *
 * Vercel Postgres is now delivered by marketplace partners (Neon and friends):
 * you install the integration once, then each database is a "store" created on
 * that installation and connected to a project, which injects DATABASE_URL and
 * its siblings into the project's environment.
 *
 * Installing the integration itself is an OAuth/consent flow that cannot be
 * completed by an API token, so this command provisions against an ALREADY
 * INSTALLED integration and tells you exactly how to install one otherwise.
 * Pretending to automate that step would just fail in a less obvious place.
 */

const POSTGRES_HINTS = ["neon", "postgres", "supabase", "prisma-postgres"];

function looksLikePostgres(slug: string, name = ""): boolean {
  const haystack = `${slug} ${name}`.toLowerCase();
  return POSTGRES_HINTS.some((hint) => haystack.includes(hint));
}

/** `drk-deploy db:provision` — create a Postgres store and attach it to the project. */
export async function dbProvision(
  cliRoot: string,
  options: { name?: string; integration?: string; product?: string; dryRun?: boolean },
): Promise<void> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const profile = resolveProfile(config);

  heading("Provision Postgres");
  info(dim(`  ${describeProfile(profile)}`));

  /**
   * The same question `migrate` asks, asked at the other end of the same
   * decision: does this deployment own a database?
   *
   * Connecting a marketplace store injects a fresh `DATABASE_URL` into the
   * project, which for a satellite on the kit's database means silently
   * pointing the consumer at an EMPTY Postgres. It boots, `/api/health/ready`
   * returns 200 because the connection works, and then every session lookup
   * and every handoff nonce burn misses — while `migrate` refuses to populate
   * it, because this deployment still does not own the schema.
   *
   * Derived from `migrationPolicy` rather than re-tested here, so schema
   * ownership is decided in exactly one place.
   */
  const policy = migrationPolicy(profile);
  if (!policy.allowed) {
    info("");
    throw new CliError("Refusing to provision: this deployment does not own a database.", {
      hint: "It runs against the KIT's Postgres — a new store would point it at an empty one. Provision from the kit's own vercel-cli checkout (its DATABASE_URL is the value this app needs), or, if this satellite genuinely has its own database, record that first with `drk-deploy init --own-database`.",
      exitCode: 2,
    });
  }

  step("Looking for an installed storage integration");
  const configurations = await client.listIntegrationConfigurations();
  const candidates = options.integration
    ? configurations.filter((c) => c.slug === options.integration || c.id === options.integration)
    : configurations.filter((c) => looksLikePostgres(c.slug));

  if (configurations.length === 0 || candidates.length === 0) {
    heading("No Postgres integration is installed");
    info("Installing a marketplace integration needs an interactive consent step, so it cannot");
    info("be done with an API token. Run this once, then re-run `drk-deploy db:provision`:");
    info("");
    info(`    ${bold("vercel integration add neon")}`);
    info("");
    info(dim("  (or install one from https://vercel.com/marketplace — any Postgres product works)"));
    if (configurations.length > 0) {
      info("");
      info(dim(`  installed integrations: ${configurations.map((c) => c.slug || c.id).join(", ")}`));
    }
    throw new CliError("No Postgres integration available to provision from.", { exitCode: 2 });
  }

  const configuration = candidates[0]!;
  ok(`Using integration ${bold(configuration.slug || configuration.id)} ${dim(configuration.id)}`);

  step("Listing its products");
  const products = await client.listIntegrationProducts(configuration.id);
  const product = options.product
    ? products.find((p) => p.slug === options.product || p.id === options.product)
    : (products.find((p) => looksLikePostgres(p.slug, p.name)) ?? products[0]);

  if (!product) {
    throw new CliError("That integration exposes no products to provision.", {
      hint: products.length ? `Available: ${products.map((p) => p.slug).join(", ")}` : undefined,
    });
  }
  ok(`Product ${bold(product.name)} ${dim(product.slug || product.id)}`);

  const storeName = options.name ?? `${config.appName.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-db`;

  if (options.dryRun) {
    info("");
    warn(`--dry-run: would create store ${bold(storeName)} and connect it to ${config.projectId}.`);
    return;
  }

  step(`Creating store ${storeName} (free plan auto-selected)`);
  const store = await client.createIntegrationStore({
    name: storeName,
    integrationConfigurationId: configuration.id,
    integrationProductIdOrSlug: product.slug || product.id,
  });
  ok(`Store ${bold(storeName)} ${dim(store.id)} — status ${store.status}`);

  step("Connecting it to the project");
  await client.connectStoreToProject({
    integrationConfigurationId: configuration.id,
    resourceId: store.id,
    projectId: config.projectId,
  });
  ok("Connected — the provider injected its connection variables into the project");

  heading("Before you migrate");
  info("Marketplace Postgres usually injects BOTH a pooled and a direct connection string.");
  info(`Migrations must use the ${bold("DIRECT (non-pooled)")} one: DDL and the advisory lock the`);
  info("migration runner takes cannot travel through a transaction pooler.");
  info("");
  info(`Check what landed:  ${bold("drk-deploy env:check")}`);
  // A satellite that reaches this point owns its database, and `migrate`
  // demands it NAME that database rather than inheriting the kit's
  // PRODUCTION_DIRECT_DATABASE_URL from the shell — so the two commands must
  // agree about which one to print.
  info(
    profile.kind === "satellite"
      ? `Then migrate with:  ${bold("drk-deploy migrate --database-url <direct-url>")} ${dim("(a satellite must name its own database)")}`
      : `Then migrate with:  ${bold("drk-deploy migrate --database-url <direct-url>")}`,
  );
}

/** `drk-deploy db:status` — what the project believes about its database. */
export async function dbStatus(cliRoot: string): Promise<void> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const profile = resolveProfile(config);

  heading("Database wiring");
  info(dim(`  ${describeProfile(profile)}`));
  const envs = await client.listEnv(config.projectId);
  const dbVars = envs.filter((e) => /^(DATABASE_|POSTGRES_|PG)/.test(e.key) || e.key === "DB_SCHEMA");

  if (dbVars.length === 0) {
    warn("No database variables are set on this project.");
    // Same split as db:provision itself: a deployment that does not own a
    // schema must be handed the kit's connection string, not a new store.
    info(
      migrationPolicy(profile).allowed
        ? `Provision one with ${bold("drk-deploy db:provision")}, or set DATABASE_URL yourself.`
        : `This deployment runs against the ${bold("KIT's")} database: set DATABASE_URL (and DB_SCHEMA) to the primary's values. ${dim("db:provision is refused here — a new store would be empty.")}`,
    );
    return;
  }
  for (const v of dbVars) field(v.key, `${dim(v.target.join(",") || "no target")}  ${dim(v.type)}`, 32);
  info("");
  info(dim("  Values are encrypted — Vercel does not return them, so only presence is shown."));
}
